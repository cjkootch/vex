import { parseArgs } from "node:util";
import { createId } from "@vex/domain";
import { loadEnv } from "@vex/config";
import { addNormalizationJob, createQueues, createRedisConnection } from "@vex/agents";
import {
  ActivityRepository,
  ContactRepository,
  EventRepository,
  RawEventRepository,
  TouchpointRepository,
  createDb,
  withTenant,
} from "@vex/db";
import {
  ResendNormalizer,
  TwilioNormalizer,
  loadWebhookFixture,
  type NormalizerOutcome,
  type RawEventInput,
} from "@vex/integrations";

interface ParsedArgs {
  fixture?: string;
  provider?: "resend" | "twilio";
  rawEventId?: string;
  dlq?: boolean;
  tenantId?: string;
}

function parseInput(): ParsedArgs {
  const { values } = parseArgs({
    options: {
      fixture: { type: "string" },
      provider: { type: "string" },
      "raw-event-id": { type: "string" },
      dlq: { type: "boolean" },
      "tenant-id": { type: "string" },
    },
    strict: true,
  });
  const provider = values.provider as string | undefined;
  if (provider && provider !== "resend" && provider !== "twilio") {
    throw new Error("--provider must be 'resend' or 'twilio'");
  }
  const out: ParsedArgs = { dlq: Boolean(values.dlq) };
  if (values.fixture) out.fixture = values.fixture as string;
  if (provider) out.provider = provider as "resend" | "twilio";
  if (values["raw-event-id"]) out.rawEventId = values["raw-event-id"] as string;
  if (values["tenant-id"]) out.tenantId = values["tenant-id"] as string;
  return out;
}

async function runFixture(
  fixturePath: string,
  provider: "resend" | "twilio",
  tenantId: string,
): Promise<NormalizerOutcome> {
  const fixture = loadWebhookFixture(fixturePath);
  const env = loadEnv();
  const db = createDb(env.APPLICATION_DATABASE_URL);
  const contacts = new ContactRepository();
  const touchpoints = new TouchpointRepository();
  const activities = new ActivityRepository();
  const events = new EventRepository();

  return withTenant(db, tenantId, async (tx) => {
    const normalizerDeps = { tx, contacts, touchpoints, activities, events };
    const input: RawEventInput = {
      id: createId(),
      tenantId,
      provider,
      providerEventId:
        provider === "resend"
          ? (fixture.headers["svix-id"] ?? createId())
          : ((fixture.payload["CallSid"] ?? fixture.payload["MessageSid"] ?? createId()) as string),
      receivedAt: new Date(),
      headers: fixture.headers,
      payload: fixture.payload,
    };
    const normalizer =
      provider === "resend"
        ? new ResendNormalizer(normalizerDeps)
        : new TwilioNormalizer(normalizerDeps);
    return normalizer.normalize(input);
  });
}

/**
 * Outcome shape for a replay enqueue. `added` is the fresh-enqueue path
 * (no prior job); `retried` is a failed job moved from the failed set
 * back into waiting via BullMQ's `.retry()`; `replaced` is a completed
 * job removed and re-added so the normalizer runs fresh; `skipped` is
 * when a job with the same id is already in-flight or queued.
 */
export type ReplayAction = "added" | "retried" | "replaced" | "skipped";
export interface ReplayResult {
  raw_event_id: string;
  action: ReplayAction;
  prior_state?: string;
}

/**
 * Resolve the dedup collision between {@link addNormalizationJob}
 * (which uses `raw_event_id` as BullMQ `jobId` for webhook-retry
 * dedup) and ops replays. A plain `.add()` is a silent no-op when the
 * jobId already exists, so:
 *
 *   - existing `failed`           → `retry()` (cheap, keeps history)
 *   - existing `completed`        → `remove()` + fresh `add()` so the
 *                                    normalizer actually runs again
 *   - existing `active`/`waiting`/`delayed` → skip; the job is already
 *                                    in the pipeline
 *   - no existing job             → fresh `add()`
 */
export async function replayOneJob(
  queue: Parameters<typeof addNormalizationJob>[0],
  data: { raw_event_id: string; tenant_id: string },
): Promise<ReplayResult> {
  const existing = await queue.getJob(data.raw_event_id);
  if (!existing) {
    await addNormalizationJob(queue, data);
    return { raw_event_id: data.raw_event_id, action: "added" };
  }

  const state = await existing.getState();
  if (state === "failed") {
    await existing.retry();
    return {
      raw_event_id: data.raw_event_id,
      action: "retried",
      prior_state: state,
    };
  }
  if (state === "completed") {
    await existing.remove();
    await addNormalizationJob(queue, data);
    return {
      raw_event_id: data.raw_event_id,
      action: "replaced",
      prior_state: state,
    };
  }
  // active / waiting / delayed / waiting-children / prioritized etc.
  return {
    raw_event_id: data.raw_event_id,
    action: "skipped",
    prior_state: state,
  };
}

async function reEnqueueOne(
  rawEventId: string,
  tenantId: string,
): Promise<ReplayResult> {
  const env = loadEnv();
  const conn = createRedisConnection(env.REDIS_URL);
  const queues = createQueues(conn);
  try {
    return await replayOneJob(queues.normalization, {
      raw_event_id: rawEventId,
      tenant_id: tenantId,
    });
  } finally {
    await queues.close();
    conn.disconnect();
  }
}

async function reEnqueueDlq(
  tenantId: string,
): Promise<{ count: number; results: ReplayResult[] }> {
  const env = loadEnv();
  const db = createDb(env.APPLICATION_DATABASE_URL);
  const repo = new RawEventRepository();
  const failed = await withTenant(db, tenantId, async (tx) => repo.listFailed(tx));

  const conn = createRedisConnection(env.REDIS_URL);
  const queues = createQueues(conn);
  const results: ReplayResult[] = [];
  try {
    for (const r of failed) {
      results.push(
        await replayOneJob(queues.normalization, {
          raw_event_id: r.id,
          tenant_id: r.tenantId,
        }),
      );
    }
  } finally {
    await queues.close();
    conn.disconnect();
  }
  return { count: failed.length, results };
}

async function main(): Promise<void> {
  const args = parseInput();
  const tenantId = args.tenantId ?? "01HSEEDWRK0000000000000001";

  if (args.fixture) {
    if (!args.provider) throw new Error("--provider is required with --fixture");
    const outcome = await runFixture(args.fixture, args.provider, tenantId);
    // eslint-disable-next-line no-console
    console.log(JSON.stringify({ replay: "fixture", outcome }));
    return;
  }

  if (args.rawEventId) {
    const result = await reEnqueueOne(args.rawEventId, tenantId);
    // eslint-disable-next-line no-console
    console.log(JSON.stringify({ replay: "raw-event", ...result }));
    return;
  }

  if (args.dlq) {
    const { count, results } = await reEnqueueDlq(tenantId);
    // eslint-disable-next-line no-console
    console.log(JSON.stringify({ replay: "dlq", count, results }));
    return;
  }

  throw new Error(
    "specify one of: --fixture <path> --provider <resend|twilio> | --raw-event-id <ulid> | --dlq",
  );
}

// Only run the CLI when this module is the entrypoint. Prevents
// `main()` from firing when a test file imports the helpers.
const invokedDirectly =
  typeof process.argv[1] === "string" &&
  import.meta.url === `file://${process.argv[1]}`;
if (invokedDirectly) {
  main().catch((err) => {
    // eslint-disable-next-line no-console
    console.error(err);
    process.exit(1);
  });
}
