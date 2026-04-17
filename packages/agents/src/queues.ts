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
  Transcript: "transcript",
} as const;
export type QueueName = (typeof QueueName)[keyof typeof QueueName];

/**
 * Concurrency caps. Tuned per queue:
 *   - normalization: many short jobs, IO-heavy → 10
 *   - dlq: low-volume audit work, manual review pace → 2
 *   - agents: each job hits Claude → 4 to keep token bursts smooth
 *   - approval-executor: low volume, runs after a human approves → 2
 *   - transcript: each job hits Claude twice (summary + action items) → 4
 */
export const QueueConcurrency: Record<QueueName, number> = {
  [QueueName.Normalization]: 10,
  [QueueName.Dlq]: 2,
  [QueueName.Agents]: 4,
  [QueueName.ApprovalExecutor]: 2,
  [QueueName.Transcript]: 4,
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
export type AgentJobKind = "daily_brief" | "research" | "follow_up";
export interface AgentJobData {
  kind: AgentJobKind;
  workspace_id: string;
  /** Agent-specific input — `research` carries `{ organization_id }`. */
  input?: Record<string, unknown>;
}

/** Approval-executor job — runs the side effect of an approved row. */
export interface ApprovalExecutorJobData {
  approval_id: string;
  workspace_id: string;
}

/**
 * Transcript-processor job — consumed after the user ends a browser voice
 * session. The job fetches the transcript (from OpenAI Realtime session
 * state or from `transcript_text` in the payload), uploads it to S3,
 * writes an activity + touchpoint, and asks Claude to summarise +
 * extract explicit commitments as T2 approvals.
 *
 * The `session_id` is the OpenAI Realtime session id (also used as the
 * BullMQ jobId so retries don't double-process).
 */
export interface TranscriptJobData {
  session_id: string;
  tenant_id: string;
  workspace_id: string;
  org_id?: string;
  contact_id?: string;
  /** Plain-text transcript. Must be provided by the caller. */
  transcript_text: string;
  duration_seconds: number;
  /** Token usage reported by OpenAI for cost accounting (all optional). */
  input_audio_tokens?: number;
  output_audio_tokens?: number;
  input_text_tokens?: number;
  output_text_tokens?: number;
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
  transcript: Queue<TranscriptJobData>;
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
  const transcript = new Queue<TranscriptJobData>(QueueName.Transcript, {
    connection,
    defaultJobOptions: {
      attempts: 3,
      backoff: { type: "exponential", delay: 3_000 },
      removeOnComplete: { count: 500, age: 7 * 24 * 3600 },
      removeOnFail: { count: 1_000, age: 30 * 24 * 3600 },
    },
  });
  return {
    normalization,
    dlq,
    agents,
    approvalExecutor,
    transcript,
    async close() {
      await normalization.close();
      await dlq.close();
      await agents.close();
      await approvalExecutor.close();
      await transcript.close();
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
}

export async function addApprovalExecutorJob(
  queue: Queue<ApprovalExecutorJobData>,
  data: ApprovalExecutorJobData,
): Promise<void> {
  await queue.add("execute", data, { jobId: data.approval_id });
}

/**
 * Enqueue a transcript-processor job. `session_id` is the OpenAI Realtime
 * session id and is used as the BullMQ jobId, so retries / duplicate
 * calls to `/voice/sessions/:id/end` can't double-process.
 */
export async function addTranscriptJob(
  queue: Queue<TranscriptJobData>,
  data: TranscriptJobData,
): Promise<void> {
  await queue.add("transcript", data, { jobId: data.session_id });
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

export function createTranscriptWorker(
  processor: Processor<TranscriptJobData, unknown>,
  connection: Redis,
): Worker<TranscriptJobData> {
  return new Worker<TranscriptJobData>(QueueName.Transcript, processor, {
    connection,
    concurrency: QueueConcurrency[QueueName.Transcript],
  });
}
