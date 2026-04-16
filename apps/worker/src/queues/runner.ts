import { Worker as BullWorker, type Processor } from "bullmq";
import IORedis from "ioredis";

export interface BullRunnerOptions {
  redisUrl: string;
  concurrency?: number;
}

/**
 * The default job queue. Per-feature processors (integration fan-out, webhook
 * delivery, etc.) will be registered as they land in later sprints; for
 * Sprint 0 we only start the worker so the process boots cleanly.
 */
const DEFAULT_QUEUE = "vex.default";

const noopProcessor: Processor = async () => undefined;

export async function startBullWorker(options: BullRunnerOptions): Promise<BullWorker> {
  const connection = new IORedis(options.redisUrl, { maxRetriesPerRequest: null });
  const worker = new BullWorker(DEFAULT_QUEUE, noopProcessor, {
    connection,
    concurrency: options.concurrency ?? 4,
  });
  await worker.waitUntilReady();
  return worker;
}
