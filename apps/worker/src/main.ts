import { loadEnv } from "@vex/config";
import {
  CampaignEnrollmentRepository,
  EventRepository,
  FollowUpRepository,
  SignalRepository,
  OrganizationRepository,
  TouchpointRepository,
  WorkspaceRepository,
  createDb,
} from "@vex/db";
import {
  AnthropicAdapter,
  S3Uploader,
  createResendClient,
  createTemporalClient,
  createTwilioClient,
} from "@vex/integrations";
import { InMemoryCostLedger, initOtel, shutdownOtel } from "@vex/telemetry";
import { AgentScanner } from "./scanner.js";
import { runEnrollmentReconciliationTick } from "./jobs/enrollment-reconciliation-job.js";
import { runFollowUpNotifierTick } from "./jobs/follow-up-notifier-job.js";
import { runSignalsTick } from "./jobs/signals-job.js";
import { runDailyDigest } from "./jobs/daily-digest-job.js";
import { runIntentClassifierTick } from "./jobs/intent-classifier-job.js";
import { startBullWorker } from "./queues/runner.js";
import { startTemporalWorker } from "./temporal/runner.js";

const DEFAULT_WORKSPACE_ID = "01HSEEDWRK0000000000000001";
const SCANNER_INTERVAL_MS = 60 * 60 * 1000;
/** Intent classifier runs every 10 minutes. Inbound replies should
 *  get labelled fast so the CampaignEnrollmentWorkflow branches
 *  without waiting for the next scheduled tick. */
const INTENT_CLASSIFIER_INTERVAL_MS = 10 * 60 * 1000;
/** Reconcile orphaned enrollments every 15 minutes — longer than the
 *  default staleness threshold so we don't race a just-enrolled row. */
const ENROLLMENT_RECONCILIATION_INTERVAL_MS = 15 * 60 * 1000;
/** Sprint Q — follow-up notifier tick. 5 minutes balances latency
 *  (reminders fire within a few minutes of due_at) against email
 *  provider rate-limiting and cost. */
const FOLLOW_UP_NOTIFIER_INTERVAL_MS = 5 * 60 * 1000;
/** Sprint T — proactive-signal rule engine. 10 minutes gives a
 *  responsive feel for laycan / stale / overdue signals without
 *  hammering the DB (every rule is a handful of indexed queries). */
const SIGNALS_INTERVAL_MS = 10 * 60 * 1000;
/** Sprint U — daily digest. Runs every hour; the handler guards so
 *  it only sends at the configured local hour (default 7am UTC = 2am
 *  CT, a bit early — set DIGEST_HOUR_UTC to taste). */
const DIGEST_CHECK_INTERVAL_MS = 60 * 60 * 1000;
const DIGEST_HOUR_UTC = Number.parseInt(
  process.env["DIGEST_HOUR_UTC"] ?? "12",
  10,
);
const DIGEST_TO_EMAIL = process.env["DIGEST_TO_EMAIL"] ?? "";

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

  // Temporal client — shared between the approval-executor
  // (campaign.enroll_batch branch), the intent classifier, and the
  // enrollment reconciliation cron. Best-effort: a missing cluster
  // means the executor still materialises rows and the reconciler
  // can't fire — the next boot with Temporal back online adopts them.
  let temporalClient: Awaited<ReturnType<typeof createTemporalClient>> | null = null;
  try {
    temporalClient = await createTemporalClient({
      address: env.TEMPORAL_ADDRESS,
      namespace: env.TEMPORAL_NAMESPACE,
    });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn(
      `worker: Temporal client unavailable at boot (${(err as Error).message}); campaign workflows will fall back to reconciliation`,
    );
  }

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
    temporal: temporalClient?.client ?? null,
    twilio:
      env.TWILIO_ACCOUNT_SID && env.TWILIO_AUTH_TOKEN && env.TWILIO_PHONE_NUMBER
        ? {
            accountSid: env.TWILIO_ACCOUNT_SID,
            authToken: env.TWILIO_AUTH_TOKEN,
            fromNumber: env.TWILIO_PHONE_NUMBER,
            ...(env.TWILIO_WHATSAPP_FROM
              ? { whatsappFrom: env.TWILIO_WHATSAPP_FROM }
              : {}),
          }
        : null,
    resend: env.RESEND_API_KEY
      ? {
          apiKey: env.RESEND_API_KEY,
          defaultFrom: env.RESEND_DEFAULT_FROM,
        }
      : null,
    slack: env.SLACK_WEBHOOK_URL
      ? {
          webhookUrl: env.SLACK_WEBHOOK_URL,
          appBaseUrl: env.APP_BASE_URL ?? null,
        }
      : null,
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

  // Temporal worker uses the Rust SDK-core, which eagerly dials the
  // address via NativeConnection.connect and throws if it can't reach
  // it. The API gets away with a "localhost:7233" placeholder because
  // it only uses the Temporal *client* (lazy). The worker does not.
  // Skip the worker when TEMPORAL_ADDRESS is still the placeholder so
  // first-boot on Fly doesn't crash-loop. BullMQ keeps running;
  // Temporal workflows stay dormant until a real address is set.
  const temporal =
    env.TEMPORAL_ADDRESS === "localhost:7233"
      ? null
      : await startTemporalWorker({
          address: env.TEMPORAL_ADDRESS,
          namespace: env.TEMPORAL_NAMESPACE,
          taskQueue: env.TEMPORAL_TASK_QUEUE,
          db,
          anthropic,
          costLedger,
          ...callBundle,
        });

  if (!temporal) {
    // eslint-disable-next-line no-console
    console.warn(
      'worker: TEMPORAL_ADDRESS is "localhost:7233" (placeholder) — ' +
        "skipping Temporal worker. BullMQ jobs will run; Temporal " +
        "workflows (follow-ups, research, campaign enrollment, " +
        "outbound calls) stay dormant until a real Temporal address " +
        "is set via fly secrets.",
    );
  }

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

  // Intent classifier — scans inbound touchpoints every 10 minutes,
  // labels them, and signals live CampaignEnrollmentWorkflow(s)
  // through the shared Temporal client (opened above).
  let intentTimer: NodeJS.Timeout | null = null;
  const intentTouchpoints = new TouchpointRepository();
  const intentEnrollments = new CampaignEnrollmentRepository();
  const intentEvents = new EventRepository();
  const runIntentTick = (): void => {
    void runIntentClassifierTick(
      {
        db,
        touchpoints: intentTouchpoints,
        enrollments: intentEnrollments,
        events: intentEvents,
        anthropic,
        temporal: temporalClient?.client ?? null,
      },
      { tenantId: DEFAULT_WORKSPACE_ID },
    )
      .then((result) => {
        if (result.scanned > 0) {
          // eslint-disable-next-line no-console
          console.log(
            `intent-classifier: scanned=${result.scanned} classified=${result.classified} unsubscribes=${result.unsubscribes} signals=${result.signalsSent}`,
          );
        }
      })
      .catch((err) => {
        // eslint-disable-next-line no-console
        console.error("intent-classifier tick failed", err);
      });
  };
  intentTimer = setInterval(runIntentTick, INTENT_CLASSIFIER_INTERVAL_MS);
  runIntentTick();

  // Enrollment reconciliation — finds enrollments in `enrolled`
  // state without a running workflow and restarts them. Covers
  // Temporal-unreachable-at-enroll + worker-restart cases.
  let reconcilerTimer: NodeJS.Timeout | null = null;
  const reconcilerEnrollments = new CampaignEnrollmentRepository();
  const reconcilerEvents = new EventRepository();
  const runReconcilerTick = (): void => {
    void runEnrollmentReconciliationTick(
      {
        db,
        enrollments: reconcilerEnrollments,
        events: reconcilerEvents,
        temporal: temporalClient?.client ?? null,
      },
      { tenantId: DEFAULT_WORKSPACE_ID },
    )
      .then((result) => {
        if (result.restarted > 0 || result.failures > 0) {
          // eslint-disable-next-line no-console
          console.log(
            `reconciler: scanned=${result.scanned} healthy=${result.healthy} restarted=${result.restarted} failures=${result.failures}`,
          );
        }
      })
      .catch((err) => {
        // eslint-disable-next-line no-console
        console.error("reconciler tick failed", err);
      });
  };
  reconcilerTimer = setInterval(
    runReconcilerTick,
    ENROLLMENT_RECONCILIATION_INTERVAL_MS,
  );
  runReconcilerTick();

  // Sprint Q — follow-up notifier. Scans open follow-ups whose
  // due_at has passed and that haven't been notified yet; emails
  // the assignee (when it's an email-shaped string) and marks the
  // row so we don't spam.
  let notifierTimer: NodeJS.Timeout | null = null;
  const notifierFollowUps = new FollowUpRepository();
  const notifierEvents = new EventRepository();
  const notifierResend = env.RESEND_API_KEY
    ? createResendClient({
        apiKey: env.RESEND_API_KEY,
        defaultFrom: env.RESEND_DEFAULT_FROM,
      })
    : null;
  const runNotifierTick = (): void => {
    void runFollowUpNotifierTick(
      {
        db,
        followUps: notifierFollowUps,
        events: notifierEvents,
        resend: notifierResend,
      },
      { tenantId: DEFAULT_WORKSPACE_ID },
    )
      .then((result) => {
        if (result.notified > 0 || result.failures > 0) {
          // eslint-disable-next-line no-console
          console.log(
            `notifier: scanned=${result.scanned} notified=${result.notified} skipped=${result.skipped} failures=${result.failures}`,
          );
        }
      })
      .catch((err) => {
        // eslint-disable-next-line no-console
        console.error("notifier tick failed", err);
      });
  };
  notifierTimer = setInterval(
    runNotifierTick,
    FOLLOW_UP_NOTIFIER_INTERVAL_MS,
  );
  runNotifierTick();

  // Sprint T — proactive-signal rule engine. Laycan / stale / overdue
  // / silent-contact rules run every 10 minutes and idempotently
  // fire signals via the unique-index dedupe on (tenant, rule,
  // subject) WHERE acknowledged_at IS NULL.
  let signalsTimer: NodeJS.Timeout | null = null;
  const signalsRepo = new SignalRepository();
  const runSignalsTickFn = (): void => {
    void runSignalsTick(
      { db, signals: signalsRepo },
      { tenantId: DEFAULT_WORKSPACE_ID },
    )
      .then((result) => {
        if (result.fired > 0 || result.resolved > 0) {
          // eslint-disable-next-line no-console
          console.log(
            `signals: fired=${result.fired} resolved=${result.resolved} rules=${result.rulesRun}`,
          );
        }
      })
      .catch((err) => {
        // eslint-disable-next-line no-console
        console.error("signals tick failed", err);
      });
  };
  signalsTimer = setInterval(runSignalsTickFn, SIGNALS_INTERVAL_MS);
  runSignalsTickFn();

  // Sprint U — daily digest. Tick every hour, send only when the
  // current UTC hour matches DIGEST_HOUR_UTC. `lastDigestDate` guards
  // against double-sends if the worker restarts inside the hour.
  let digestTimer: NodeJS.Timeout | null = null;
  let lastDigestDate = "";
  const runDigestCheck = (): void => {
    const now = new Date();
    const today = now.toISOString().slice(0, 10);
    if (
      now.getUTCHours() !== DIGEST_HOUR_UTC ||
      lastDigestDate === today
    ) {
      return;
    }
    lastDigestDate = today;
    void runDailyDigest(
      {
        db,
        events: notifierEvents,
        signals: signalsRepo,
        resend: notifierResend,
      },
      {
        tenantId: DEFAULT_WORKSPACE_ID,
        to: DIGEST_TO_EMAIL || null,
      },
    )
      .then((result) => {
        // eslint-disable-next-line no-console
        console.log(
          `daily-digest: sent=${result.sent} skipped=${result.skippedReason ?? "-"} signals=${result.signals_open} events=${result.events_last_24h} follow_ups_today=${result.followups_due_today}`,
        );
      })
      .catch((err) => {
        // eslint-disable-next-line no-console
        console.error("daily-digest failed", err);
      });
  };
  digestTimer = setInterval(runDigestCheck, DIGEST_CHECK_INTERVAL_MS);
  runDigestCheck();

  const shutdown = async (): Promise<void> => {
    clearInterval(scannerTimer);
    if (intentTimer) clearInterval(intentTimer);
    if (reconcilerTimer) clearInterval(reconcilerTimer);
    if (notifierTimer) clearInterval(notifierTimer);
    if (signalsTimer) clearInterval(signalsTimer);
    if (digestTimer) clearInterval(digestTimer);
    await bull.close();
    if (temporal) temporal.shutdown();
    if (temporalClient) await temporalClient.close();
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
