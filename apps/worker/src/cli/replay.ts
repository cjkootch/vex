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

async function reEnqueueOne(rawEventId: string, tenantId: string): Promise<void> {
  const env = loadEnv();
  const conn = createRedisConnection(env.REDIS_URL);
  const queues = createQueues(conn);
  try {
    await addNormalizationJob(queues.normalization, {
      raw_event_id: rawEventId,
      tenant_id: tenantId,
    });
  } finally {
    await queues.close();
    conn.disconnect();
  }
}

async function reEnqueueDlq(tenantId: string): Promise<number> {
  const env = loadEnv();
  const db = createDb(env.APPLICATION_DATABASE_URL);
  const repo = new RawEventRepository();
  const failed = await withTenant(db, tenantId, async (tx) => repo.listFailed(tx));

  const conn = createRedisConnection(env.REDIS_URL);
  const queues = createQueues(conn);
  try {
    for (const r of failed) {
      await addNormalizationJob(queues.normalization, {
        raw_event_id: r.id,
        tenant_id: r.tenantId,
      });
    }
  } finally {
    await queues.close();
    conn.disconnect();
  }
  return failed.length;
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
    await reEnqueueOne(args.rawEventId, tenantId);
    // eslint-disable-next-line no-console
    console.log(JSON.stringify({ replay: "raw-event", id: args.rawEventId }));
    return;
  }

  if (args.dlq) {
    const count = await reEnqueueDlq(tenantId);
    // eslint-disable-next-line no-console
    console.log(JSON.stringify({ replay: "dlq", count }));
    return;
  }

  throw new Error(
    "specify one of: --fixture <path> --provider <resend|twilio> | --raw-event-id <ulid> | --dlq",
  );
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});
