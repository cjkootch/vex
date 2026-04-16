import { loadEnv } from "@vex/config";
import { initOtel, shutdownOtel } from "@vex/telemetry";
import { startBullWorker } from "./queues/runner.js";
import { startTemporalWorker } from "./temporal/runner.js";

/**
 * The worker process hosts two runtimes:
 *   - BullMQ workers for short-lived Redis-backed jobs (webhooks, fan-out).
 *   - Temporal workers for durable orchestrations (agent runs, integrations).
 */
async function main(): Promise<void> {
  const env = loadEnv();

  initOtel({
    serviceName: "vex-worker",
    serviceNamespace: env.OTEL_SERVICE_NAMESPACE,
    otlpEndpoint: env.OTEL_EXPORTER_OTLP_ENDPOINT,
  });

  const bull = await startBullWorker({ redisUrl: env.REDIS_URL });
  const temporal = await startTemporalWorker({
    address: env.TEMPORAL_ADDRESS,
    namespace: env.TEMPORAL_NAMESPACE,
    taskQueue: env.TEMPORAL_TASK_QUEUE,
  });

  const shutdown = async (): Promise<void> => {
    await bull.close();
    temporal.shutdown();
    await shutdownOtel();
  };
  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error("worker failed to start", err);
  process.exit(1);
});
