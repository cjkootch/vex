import type { Worker } from "bullmq";
import {
  buildDlqProcessor,
  buildNormalizationProcessor,
  createDlqWorker,
  createNormalizationWorker,
  createQueues,
  createRedisConnection,
  type QueueHandles,
} from "@vex/agents";
import {
  ActivityRepository,
  ContactRepository,
  EventRepository,
  RawEventRepository,
  TouchpointRepository,
  createDb,
} from "@vex/db";

export interface QueueRunnerOptions {
  redisUrl: string;
  applicationDatabaseUrl: string;
  concurrency?: number;
}

export interface QueueRunner {
  queues: QueueHandles;
  normalizationWorker: Worker;
  dlqWorker: Worker;
  close: () => Promise<void>;
}

/**
 * Bootstrap the BullMQ workers for normalization + DLQ. The factory wires
 * Redis, queues, repositories, and processors. Returns handles so the
 * caller can shut everything down on SIGINT.
 */
export async function startBullWorker(options: QueueRunnerOptions): Promise<QueueRunner> {
  const connection = createRedisConnection(options.redisUrl);
  const queues = createQueues(connection);

  const db = createDb(options.applicationDatabaseUrl);
  const rawEvents = new RawEventRepository(db);
  const contacts = new ContactRepository(db);
  const touchpoints = new TouchpointRepository(db);
  const activities = new ActivityRepository(db);
  const events = new EventRepository(db);

  const normalizationProcessor = buildNormalizationProcessor({
    rawEvents,
    contacts,
    touchpoints,
    activities,
    events,
  });

  const dlqProcessor = buildDlqProcessor({ rawEvents, dlqQueue: queues.dlq });

  const normalizationWorker = createNormalizationWorker(normalizationProcessor, {
    connection,
    dlqQueue: queues.dlq,
  });
  await normalizationWorker.waitUntilReady();

  const dlqWorker = createDlqWorker(dlqProcessor, connection);
  await dlqWorker.waitUntilReady();

  return {
    queues,
    normalizationWorker,
    dlqWorker,
    async close() {
      await normalizationWorker.close();
      await dlqWorker.close();
      await queues.close();
      connection.disconnect();
    },
  };
}
