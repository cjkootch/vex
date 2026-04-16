import { loadEnv } from "@vex/config";
import {
  OrganizationRepository,
  WorkspaceRepository,
  createDb,
} from "@vex/db";
import { AnthropicAdapter, GoogleAdsAdapter } from "@vex/integrations";
import { InMemoryCostLedger, initOtel, shutdownOtel } from "@vex/telemetry";
import { AgentScanner } from "./scanner.js";
import { startBullWorker } from "./queues/runner.js";
import { startTemporalWorker } from "./temporal/runner.js";

const DEFAULT_WORKSPACE_ID = "01HSEEDWRK0000000000000001";
const SCANNER_INTERVAL_MS = 60 * 60 * 1000;

/**
 * The worker process hosts two runtimes:
 *   - BullMQ workers for short-lived Redis-backed jobs (webhooks, agents,
 *     approval-executor stub).
 *   - Temporal workers for durable orchestrations: FollowUpWorkflow (with
 *     human-approval signal) and ResearchWorkflow (multi-step with retry
 *     for the website scrape).
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

  const db = createDb(env.APPLICATION_DATABASE_URL);
  const costLedger = new InMemoryCostLedger();
  const anthropic = new AnthropicAdapter({
    apiKey: env.ANTHROPIC_API_KEY,
    costLedger,
  });

  // Google Ads — best effort. Adapter only constructs when service-account
  // JSON + developer token are both present; otherwise the LeadWon
  // workflow runs in audit-only mode.
  let ads: GoogleAdsAdapter | null = null;
  if (env.GOOGLE_SERVICE_ACCOUNT_JSON && env.GOOGLE_ADS_DEVELOPER_TOKEN) {
    ads = new GoogleAdsAdapter({
      serviceAccount: env.GOOGLE_SERVICE_ACCOUNT_JSON,
      developerToken: env.GOOGLE_ADS_DEVELOPER_TOKEN,
      ...(env.GOOGLE_ADS_LOGIN_CUSTOMER_ID
        ? { loginCustomerId: env.GOOGLE_ADS_LOGIN_CUSTOMER_ID }
        : {}),
    });
  }

  const bull = await startBullWorker({
    redisUrl: env.REDIS_URL,
    applicationDatabaseUrl: env.APPLICATION_DATABASE_URL,
    anthropicApiKey: env.ANTHROPIC_API_KEY,
    openaiApiKey: env.OPENAI_API_KEY,
    defaultWorkspaceId: DEFAULT_WORKSPACE_ID,
    googleServiceAccountJson: env.GOOGLE_SERVICE_ACCOUNT_JSON ?? null,
  });
  const temporal = await startTemporalWorker({
    address: env.TEMPORAL_ADDRESS,
    namespace: env.TEMPORAL_NAMESPACE,
    taskQueue: env.TEMPORAL_TASK_QUEUE,
    db,
    anthropic,
    costLedger,
    ads,
  });

  const scanner = new AgentScanner({
    db,
    agentsQueue: bull.queues.agents,
    workspaces: new WorkspaceRepository(),
    organizations: new OrganizationRepository(),
  });

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
