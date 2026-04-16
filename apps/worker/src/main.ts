import { loadEnv } from "@vex/config";
import {
  OrganizationRepository,
  WorkspaceRepository,
  createDb,
} from "@vex/db";
import { initOtel, shutdownOtel } from "@vex/telemetry";
import { AgentScanner } from "./scanner.js";
import { startBullWorker } from "./queues/runner.js";
import { startTemporalWorker } from "./temporal/runner.js";

const DEFAULT_WORKSPACE_ID = "01HSEEDWRK0000000000000001";
const SCANNER_INTERVAL_MS = 60 * 60 * 1000;

/**
 * The worker process hosts two runtimes:
 *   - BullMQ workers for short-lived Redis-backed jobs (webhooks, fan-out,
 *     agents, approval executor).
 *   - Temporal workers for durable orchestrations (Sprint 7+).
 *
 * Sprint 6 adds the agent scanner — a simple setInterval loop that enqueues
 * ResearchAgent jobs for stale orgs. Production will swap this for a
 * Temporal cron when Sprint 7 lands.
 */
async function main(): Promise<void> {
  const env = loadEnv();

  initOtel({
    serviceName: "vex-worker",
    serviceNamespace: env.OTEL_SERVICE_NAMESPACE,
    ...(env.OTEL_EXPORTER_OTLP_ENDPOINT
      ? { otlpEndpoint: env.OTEL_EXPORTER_OTLP_ENDPOINT }
      : {}),
  });

  const bull = await startBullWorker({
    redisUrl: env.REDIS_URL,
    applicationDatabaseUrl: env.APPLICATION_DATABASE_URL,
    anthropicApiKey: env.ANTHROPIC_API_KEY,
    openaiApiKey: env.OPENAI_API_KEY,
    defaultWorkspaceId: DEFAULT_WORKSPACE_ID,
  });
  const temporal = await startTemporalWorker({
    address: env.TEMPORAL_ADDRESS,
    namespace: env.TEMPORAL_NAMESPACE,
    taskQueue: env.TEMPORAL_TASK_QUEUE,
  });

  const db = createDb(env.APPLICATION_DATABASE_URL);
  const scanner = new AgentScanner({
    db,
    agentsQueue: bull.queues.agents,
    workspaces: new WorkspaceRepository(),
    organizations: new OrganizationRepository(),
  });

  // Kick off an immediate scan, then every hour.
  const scannerTimer = setInterval(() => {
    void scanner.scan(DEFAULT_WORKSPACE_ID).catch((err) => {
      // eslint-disable-next-line no-console
      console.error("scanner failed", err);
    });
  }, SCANNER_INTERVAL_MS);
  void scanner.scan(DEFAULT_WORKSPACE_ID).catch((err) => {
    // eslint-disable-next-line no-console
    console.error("initial scan failed", err);
  });

  const shutdown = async (): Promise<void> => {
    clearInterval(scannerTimer);
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
