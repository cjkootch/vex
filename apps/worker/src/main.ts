import { loadEnv } from "@vex/config";
import {
  OrganizationRepository,
  WorkspaceRepository,
  createDb,
} from "@vex/db";
import {
  AnthropicAdapter,
  S3Uploader,
  createTwilioClient,
} from "@vex/integrations";
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

  const bull = await startBullWorker({
    redisUrl: env.REDIS_URL,
    applicationDatabaseUrl: env.APPLICATION_DATABASE_URL,
    anthropicApiKey: env.ANTHROPIC_API_KEY,
    openaiApiKey: env.OPENAI_API_KEY,
    s3: {
      region: env.S3_REGION,
      bucket: env.S3_BUCKET,
      accessKeyId: env.S3_ACCESS_KEY_ID,
      secretAccessKey: env.S3_SECRET_ACCESS_KEY,
      ...(env.S3_ENDPOINT ? { endpoint: env.S3_ENDPOINT } : {}),
    },
    // Resend — optional. Only wired when both an API key and a default
    // From address are present; otherwise the approval executor's
    // email.send branch fails closed with `email.send_not_configured`.
    ...(env.RESEND_API_KEY && env.RESEND_FROM
      ? {
          resend: {
            apiKey: env.RESEND_API_KEY,
            defaultFrom: env.RESEND_FROM,
          },
        }
      : {}),
    defaultWorkspaceId: DEFAULT_WORKSPACE_ID,
  });
  // Sprint 12 — the OutboundCallWorkflow needs Twilio + S3 + reachable
  // webhook URLs. Bundle them only when every required env var is set;
  // otherwise the worker boots without call activities registered and
  // any attempted outbound call fails closed at the first activity.
  const callBundle =
    env.TWILIO_ACCOUNT_SID &&
    env.TWILIO_AUTH_TOKEN &&
    env.TWILIO_PHONE_NUMBER &&
    env.APP_BASE_URL
      ? {
          twilio: createTwilioClient({
            accountSid: env.TWILIO_ACCOUNT_SID,
            authToken: env.TWILIO_AUTH_TOKEN,
            fromNumber: env.TWILIO_PHONE_NUMBER,
          }),
          s3: new S3Uploader({
            region: env.S3_REGION,
            bucket: env.S3_BUCKET,
            accessKeyId: env.S3_ACCESS_KEY_ID,
            secretAccessKey: env.S3_SECRET_ACCESS_KEY,
            ...(env.S3_ENDPOINT ? { endpoint: env.S3_ENDPOINT } : {}),
          }),
          outboundCall: {
            twimlUrl: `${env.APP_BASE_URL.replace(/\/$/, "")}/calls/twilio/twiml`,
            statusCallbackUrl: `${env.APP_BASE_URL.replace(/\/$/, "")}/calls/twilio/status`,
            recordingCallbackUrl: `${env.APP_BASE_URL.replace(/\/$/, "")}/calls/twilio/recording`,
          },
        }
      : {};

  const temporal = await startTemporalWorker({
    address: env.TEMPORAL_ADDRESS,
    namespace: env.TEMPORAL_NAMESPACE,
    taskQueue: env.TEMPORAL_TASK_QUEUE,
    db,
    anthropic,
    costLedger,
    ...callBundle,
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
