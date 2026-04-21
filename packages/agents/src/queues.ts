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
export type AgentJobKind =
  | "daily_brief"
  | "research"
  | "follow_up"
  | "lead_qualification"
  | "reactivation_batch"
  | "ofac_screening"
  | "freight_market"
  | "port_intelligence";
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

/**
 * Producer-side rate limits applied on worker creation.
 *
 *   - Normalization: 50 jobs/sec — shields Neon from a webhook flood.
 *   - Agents:        10 jobs/sec — each run hits Claude, cap the burst.
 *   - Transcript:     5 jobs/sec — summarisation is Claude-heavy.
 *
 * DLQ + approval-executor aren't rate-limited — they're low volume and
 * latency-sensitive (approvals need to fire promptly after a human click).
 */
export const QueueRateLimits: Partial<
  Record<QueueName, { max: number; duration: number }>
> = {
  [QueueName.Normalization]: { max: 50, duration: 1_000 },
  [QueueName.Agents]: { max: 10, duration: 1_000 },
  [QueueName.Transcript]: { max: 5, duration: 1_000 },
};

/** Per-queue backpressure threshold (waiting + active). */
export const QueueBackpressureThreshold: Record<QueueName, number> = {
  [QueueName.Normalization]: 1_000,
  [QueueName.Dlq]: 500,
  [QueueName.Agents]: 200,
  [QueueName.ApprovalExecutor]: 200,
  [QueueName.Transcript]: 200,
};

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
  // Daily 07:00 — runs just after OFAC's overnight SDN publication so
  // the team sees any new matches in the signals inbox at start of day.
  await queue.add(
    "ofac_screening",
    { kind: "ofac_screening", workspace_id: workspaceId },
    {
      repeat: { pattern: "0 7 * * *" },
      jobId: `recurring:ofac_screening:${workspaceId}`,
    },
  );
  // Daily 06:00 — ingests freight rates + flags shifted/missing rates
  // before the desk's 07:00 daily brief so freight context is fresh.
  await queue.add(
    "freight_market",
    { kind: "freight_market", workspace_id: workspaceId },
    {
      repeat: { pattern: "0 6 * * *" },
      jobId: `recurring:freight_market:${workspaceId}`,
    },
  );
  // Daily 05:00 — port constraint + active-event checks across every
  // open deal. Runs before the freight market pass + the daily brief
  // so port warnings land in the signals inbox first thing in the
  // morning, ahead of any desk action.
  await queue.add(
    "port_intelligence",
    { kind: "port_intelligence", workspace_id: workspaceId },
    {
      repeat: { pattern: "0 5 * * *" },
      jobId: `recurring:port_intelligence:${workspaceId}`,
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
    ...(QueueRateLimits[QueueName.Normalization]
      ? { limiter: QueueRateLimits[QueueName.Normalization] }
      : {}),
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

  // Loud stdout logging on every failure (including non-terminal
  // attempts) — the DLQ handler above only fires on the final retry,
  // so without this the first two zod/DB errors vanished into thin
  // air. Combined with `active`, this gives operators a full trace
  // of the normalization pipeline per incoming webhook.
  worker.on("active", (job) => {
    console.log(
      `[bullmq] queue=${QueueName.Normalization} job=${job.id} active (attempt ${job.attemptsMade + 1}/${job.opts?.attempts ?? 1})`,
    );
  });
  worker.on("failed", (job, err) => {
    const jobId = job?.id ?? "<unknown>";
    const attemptsMade = job?.attemptsMade ?? 0;
    const attemptsMax = job?.opts?.attempts ?? 1;
    console.error(
      `[bullmq] queue=${QueueName.Normalization} job=${jobId} failed (attempt ${attemptsMade}/${attemptsMax}): ${err.message}`,
      { stack: err.stack, data: job?.data },
    );
  });
  worker.on("error", (err) => {
    console.error(
      `[bullmq] queue=${QueueName.Normalization} worker error: ${err.message}`,
      { stack: err.stack },
    );
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

/**
 * BullMQ swallows processor exceptions when no "failed" / "error"
 * listener is attached — silent failures are the worst kind when a
 * call or agent run just doesn't happen and nobody sees why. The
 * hook below also logs `active` so operators can tell "job never
 * arrived" from "job arrived + threw" in the logs.
 */
function attachFailureLogger<T>(worker: Worker<T>, queue: string): void {
  worker.on("active", (job) => {
    console.log(
      `[bullmq] queue=${queue} job=${job.id} active (attempt ${job.attemptsMade + 1}/${job.opts?.attempts ?? 1})`,
    );
  });
  worker.on("failed", (job, err) => {
    const jobId = job?.id ?? "<unknown>";
    const attemptsMade = job?.attemptsMade ?? 0;
    const attemptsMax = job?.opts?.attempts ?? 1;
    console.error(
      `[bullmq] queue=${queue} job=${jobId} failed (attempt ${attemptsMade}/${attemptsMax}): ${err.message}`,
      { stack: err.stack, data: job?.data },
    );
  });
  worker.on("error", (err) => {
    console.error(`[bullmq] queue=${queue} worker error: ${err.message}`, {
      stack: err.stack,
    });
  });
}

export function createAgentWorker(
  processor: Processor<AgentJobData, unknown>,
  connection: Redis,
): Worker<AgentJobData> {
  const worker = new Worker<AgentJobData>(QueueName.Agents, processor, {
    connection,
    concurrency: QueueConcurrency[QueueName.Agents],
    ...(QueueRateLimits[QueueName.Agents]
      ? { limiter: QueueRateLimits[QueueName.Agents] }
      : {}),
  });
  attachFailureLogger(worker, QueueName.Agents);
  return worker;
}

export function createApprovalExecutorWorker(
  processor: Processor<ApprovalExecutorJobData, unknown>,
  connection: Redis,
): Worker<ApprovalExecutorJobData> {
  const worker = new Worker<ApprovalExecutorJobData>(
    QueueName.ApprovalExecutor,
    processor,
    {
      connection,
      concurrency: QueueConcurrency[QueueName.ApprovalExecutor],
    },
  );
  attachFailureLogger(worker, QueueName.ApprovalExecutor);
  return worker;
}

export function createTranscriptWorker(
  processor: Processor<TranscriptJobData, unknown>,
  connection: Redis,
): Worker<TranscriptJobData> {
  const worker = new Worker<TranscriptJobData>(QueueName.Transcript, processor, {
    connection,
    concurrency: QueueConcurrency[QueueName.Transcript],
    ...(QueueRateLimits[QueueName.Transcript]
      ? { limiter: QueueRateLimits[QueueName.Transcript] }
      : {}),
  });
  attachFailureLogger(worker, QueueName.Transcript);
  return worker;
}

/**
 * Snapshot queue depths for all known queues. "Depth" = waiting + active
 * which is the load the system is actively shedding. Used by the worker
 * backpressure gauge and by /health/detailed.
 */
export async function getQueueDepths(
  handles: QueueHandles,
): Promise<Record<QueueName, number>> {
  const pairs: [QueueName, Queue<unknown>][] = [
    [QueueName.Normalization, handles.normalization as Queue<unknown>],
    [QueueName.Dlq, handles.dlq as Queue<unknown>],
    [QueueName.Agents, handles.agents as Queue<unknown>],
    [QueueName.ApprovalExecutor, handles.approvalExecutor as Queue<unknown>],
    [QueueName.Transcript, handles.transcript as Queue<unknown>],
  ];
  const result = {} as Record<QueueName, number>;
  for (const [name, queue] of pairs) {
    const counts = await queue.getJobCounts("waiting", "active");
    const waiting = Number(counts["waiting"] ?? 0);
    const active = Number(counts["active"] ?? 0);
    result[name] = waiting + active;
  }
  return result;
}

/**
 * Given a depth snapshot, return the set of queues currently at or over
 * their backpressure threshold. Callers should (a) emit the
 * `vex.queue.backpressure` gauge and (b) pause producers for the listed
 * queues until they recover.
 */
export function backpressureEngaged(
  depths: Record<QueueName, number>,
): QueueName[] {
  const out: QueueName[] = [];
  for (const [name, depth] of Object.entries(depths) as [QueueName, number][]) {
    const threshold = QueueBackpressureThreshold[name];
    if (threshold != null && depth >= threshold) out.push(name);
  }
  return out;
}
