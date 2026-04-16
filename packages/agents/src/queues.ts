import { Queue, Worker, type Processor } from "bullmq";
import IORedis, { type Redis } from "ioredis";

/**
 * Queue names. Centralized so producers and consumers can't typo-drift.
 */
export const QueueName = {
  Normalization: "normalization",
  Dlq: "dlq",
} as const;
export type QueueName = (typeof QueueName)[keyof typeof QueueName];

/**
 * Concurrency caps. Tuned for Sprint 2:
 *   - normalization: many short jobs, IO-heavy → 10
 *   - dlq: low-volume audit work, manual review pace → 2
 */
export const QueueConcurrency: Record<QueueName, number> = {
  [QueueName.Normalization]: 10,
  [QueueName.Dlq]: 2,
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

/**
 * Build a BullMQ Redis connection. We disable `maxRetriesPerRequest` because
 * BullMQ requires it to be `null` for blocking operations.
 */
export function createRedisConnection(redisUrl: string): Redis {
  return new IORedis(redisUrl, { maxRetriesPerRequest: null });
}

/**
 * Producer-side queue handle. Use `addNormalizationJob()` rather than
 * `queue.add()` directly so the jobId convention (raw_event_id) stays
 * uniform — that's the queue-level dedupe story.
 */
export interface QueueHandles {
  normalization: Queue<NormalizationJobData>;
  dlq: Queue<DlqJobData>;
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
  return {
    normalization,
    dlq,
    async close() {
      await normalization.close();
      await dlq.close();
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
