import { Queue, Worker, type Processor } from "bullmq";
import IORedis, { type Redis } from "ioredis";

/**
 * Queue names. Centralized so producers and consumers can't typo-drift.
 */
export const QueueName = {
  Normalization: "normalization",
  Dlq: "dlq",
  Agents: "agents",
  ApprovalExecutor: "approval-executor",
} as const;
export type QueueName = (typeof QueueName)[keyof typeof QueueName];

/**
 * Concurrency caps. Tuned per queue:
 *   - normalization: many short jobs, IO-heavy → 10
 *   - dlq: low-volume audit work, manual review pace → 2
 *   - agents: each job hits Claude → 4 to keep token bursts smooth
 *   - approval-executor: low volume, runs after a human approves → 2
 */
export const QueueConcurrency: Record<QueueName, number> = {
  [QueueName.Normalization]: 10,
  [QueueName.Dlq]: 2,
  [QueueName.Agents]: 4,
  [QueueName.ApprovalExecutor]: 2,
};

/** Job payload shapes — both queues take `{raw_event_id, tenant_id}`. */
export interface NormalizationJobData {
  raw_event_id: string;
  tenant_id: string;
}

export interface DlqJobData extends NormalizationJobData {
  error: string;
  stack?: string;
  failed_at: string;
}

/** Agent job payload — kind drives which agent the worker constructs. */
export type AgentJobKind =
  | "daily_brief"
  | "research"
  | "follow_up"
  | "marketing_analyst";
export interface AgentJobData {
  kind: AgentJobKind;
  workspace_id: string;
  /** Agent-specific input:
   *   - `research`         — `{ organization_id }`
   *   - `marketing_analyst` — `{ current, history, campaigns }` populated by
   *     the GA4 polling job before fan-out.
   */
  input?: Record<string, unknown>;
}

/** Approval-executor job — runs the side effect of an approved row. */
export interface ApprovalExecutorJobData {
  approval_id: string;
  workspace_id: string;
}

/**
 * Build a BullMQ Redis connection. We disable `maxRetriesPerRequest` because
 * BullMQ requires it to be `null` for blocking operations.
 */
export function createRedisConnection(redisUrl: string): Redis {
  return new IORedis(redisUrl, { maxRetriesPerRequest: null });
}

/**
 * Producer-side queue handles. Use the typed helpers (`addNormalizationJob`,
 * `addAgentJob`, `addApprovalExecutorJob`) rather than `queue.add()` so
 * jobId conventions stay uniform — those are the dedupe story.
 */
export interface QueueHandles {
  normalization: Queue<NormalizationJobData>;
  dlq: Queue<DlqJobData>;
  agents: Queue<AgentJobData>;
  approvalExecutor: Queue<ApprovalExecutorJobData>;
  close: () => Promise<void>;
}

export function createQueues(connection: Redis): QueueHandles {
  const normalization = new Queue<NormalizationJobData>(QueueName.Normalization, {
    connection,
    defaultJobOptions: {
      attempts: 3,
      backoff: { type: "exponential", delay: 1_000 },
      removeOnComplete: { count: 1_000, age: 24 * 3600 },
      removeOnFail: { count: 5_000, age: 7 * 24 * 3600 },
    },
  });
  const dlq = new Queue<DlqJobData>(QueueName.Dlq, {
    connection,
    defaultJobOptions: {
      attempts: 1,
      removeOnComplete: false,
      removeOnFail: false,
    },
  });
  const agents = new Queue<AgentJobData>(QueueName.Agents, {
    connection,
    defaultJobOptions: {
      attempts: 2,
      backoff: { type: "exponential", delay: 5_000 },
      removeOnComplete: { count: 500, age: 7 * 24 * 3600 },
      removeOnFail: { count: 1_000, age: 30 * 24 * 3600 },
    },
  });
  const approvalExecutor = new Queue<ApprovalExecutorJobData>(QueueName.ApprovalExecutor, {
    connection,
    defaultJobOptions: {
      attempts: 3,
      backoff: { type: "exponential", delay: 2_000 },
    },
  });
  return {
    normalization,
    dlq,
    agents,
    approvalExecutor,
    async close() {
      await normalization.close();
      await dlq.close();
      await agents.close();
      await approvalExecutor.close();
    },
  };
}

/**
 * Idempotently enqueue a normalization job. The `jobId` is the raw_event_id
 * so duplicate webhook deliveries that somehow slip past the DB-side check
 * still produce only one job.
 */
export async function addNormalizationJob(
  queue: Queue<NormalizationJobData>,
  data: NormalizationJobData,
): Promise<void> {
  await queue.add("normalize", data, { jobId: data.raw_event_id });
}

/**
 * Enqueue an agent job. `dedupeKey` is appended to the jobId so a scanner
 * sweeping the same workspace twice in a window doesn't enqueue duplicates.
 */
export async function addAgentJob(
  queue: Queue<AgentJobData>,
  data: AgentJobData,
  dedupeKey?: string,
): Promise<void> {
  const jobId = dedupeKey
    ? `${data.kind}:${data.workspace_id}:${dedupeKey}`
    : `${data.kind}:${data.workspace_id}:${Date.now()}`;
  await queue.add(data.kind, data, { jobId });
}

/**
 * Schedule the recurring agents (DailyBrief and FollowUp) on this worker.
 * Uses BullMQ's repeatable jobs — re-registering with the same `name` and
 * pattern is a no-op so it's safe to call on every worker boot.
 */
export async function scheduleRecurringAgents(
  queue: Queue<AgentJobData>,
  workspaceId: string,
): Promise<void> {
  await queue.add(
    "daily_brief",
    { kind: "daily_brief", workspace_id: workspaceId },
    {
      repeat: { pattern: "0 6 * * 1-5" },
      jobId: `recurring:daily_brief:${workspaceId}`,
    },
  );
  await queue.add(
    "follow_up",
    { kind: "follow_up", workspace_id: workspaceId },
    {
      repeat: { pattern: "0 */2 8-18 * * 1-5" },
      jobId: `recurring:follow_up:${workspaceId}`,
    },
  );
  // Marketing analyst runs top-of-hour and a daily close at 18:00 Mon-Fri.
  // The daily close is enqueued as a separate repeatable to avoid hourly
  // duplicates; jobIds disambiguate.
  await queue.add(
    "marketing_analyst",
    { kind: "marketing_analyst", workspace_id: workspaceId },
    {
      repeat: { pattern: "0 * * * *" },
      jobId: `recurring:marketing_analyst:hourly:${workspaceId}`,
    },
  );
  await queue.add(
    "marketing_analyst",
    { kind: "marketing_analyst", workspace_id: workspaceId },
    {
      repeat: { pattern: "0 18 * * 1-5" },
      jobId: `recurring:marketing_analyst:close:${workspaceId}`,
    },
  );
}

export async function addApprovalExecutorJob(
  queue: Queue<ApprovalExecutorJobData>,
  data: ApprovalExecutorJobData,
): Promise<void> {
  await queue.add("execute", data, { jobId: data.approval_id });
}

/**
 * Worker factory. Wraps `bullmq`'s Worker with sensible defaults and
 * configures the failure handler that promotes terminally-failed jobs to
 * the DLQ. Returns the live worker so the caller can `.close()` on shutdown.
 */
export interface WorkerFactoryOptions {
  connection: Redis;
  dlqQueue?: Queue<DlqJobData>;
  onTerminalFailure?: (data: NormalizationJobData, error: Error) => Promise<void>;
}

export function createNormalizationWorker(
  processor: Processor<NormalizationJobData, unknown>,
  options: WorkerFactoryOptions,
): Worker<NormalizationJobData> {
  const worker = new Worker<NormalizationJobData>(QueueName.Normalization, processor, {
    connection: options.connection,
    concurrency: QueueConcurrency[QueueName.Normalization],
  });

  worker.on("failed", async (job, err) => {
    if (!job) return;
    const remaining = (job.opts.attempts ?? 1) - job.attemptsMade;
    if (remaining > 0) return;

    const dlqPayload: DlqJobData = {
      ...job.data,
      error: err.message,
      stack: err.stack ?? "",
      failed_at: new Date().toISOString(),
    };
    if (options.dlqQueue) {
      await options.dlqQueue.add("dead", dlqPayload, { jobId: job.data.raw_event_id });
    }
    if (options.onTerminalFailure) {
      await options.onTerminalFailure(job.data, err);
    }
  });

  return worker;
}

export function createDlqWorker(
  processor: Processor<DlqJobData, unknown>,
  connection: Redis,
): Worker<DlqJobData> {
  return new Worker<DlqJobData>(QueueName.Dlq, processor, {
    connection,
    concurrency: QueueConcurrency[QueueName.Dlq],
  });
}

export function createAgentWorker(
  processor: Processor<AgentJobData, unknown>,
  connection: Redis,
): Worker<AgentJobData> {
  return new Worker<AgentJobData>(QueueName.Agents, processor, {
    connection,
    concurrency: QueueConcurrency[QueueName.Agents],
  });
}

export function createApprovalExecutorWorker(
  processor: Processor<ApprovalExecutorJobData, unknown>,
  connection: Redis,
): Worker<ApprovalExecutorJobData> {
  return new Worker<ApprovalExecutorJobData>(
    QueueName.ApprovalExecutor,
    processor,
    {
      connection,
      concurrency: QueueConcurrency[QueueName.ApprovalExecutor],
    },
  );
}
