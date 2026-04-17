import "reflect-metadata";
import { resolve } from "node:path";
import { NestFactory } from "@nestjs/core";
import {
  FastifyAdapter,
  type NestFastifyApplication,
} from "@nestjs/platform-fastify";
import { loadEnv } from "@vex/config";
import {
  ActivityRepository,
  AgentRunRepository,
  ApprovalRepository,
  ContactRepository,
  EventRepository,
  OrganizationRepository,
  RawEventRepository,
  RetrievalService,
  SummaryRepository,
  TouchpointRepository,
  WorkspaceRepository,
  createDb,
} from "@vex/db";
import {
  VoiceContextBuilder,
  createQueues,
  createRedisConnection,
} from "@vex/agents";
import {
  AnthropicAdapter,
  OpenAIAdapter,
  S3Uploader,
  TEMPORAL_TASK_QUEUE,
  createTemporalClient,
  createTwilioClient,
} from "@vex/integrations";
import { initOtel, InMemoryCostLedger, shutdownOtel } from "@vex/telemetry";
import { AppModule } from "./app.module.js";
import { WebhooksModule } from "./webhooks/webhooks.module.js";
import { QueryModule } from "./query/query.module.js";
import { ApprovalsModule } from "./approvals/approvals.module.js";
import { AgentRunsModule } from "./agent-runs/agent-runs.module.js";
import { AdminModule } from "./admin/admin.module.js";
import { BriefModule } from "./brief/brief.module.js";
import { CallsModule } from "./calls/calls.module.js";
import { ContactsModule } from "./contacts/contacts.module.js";
import { DealsModule } from "./deals/deals.module.js";
import { VoiceModule } from "./voice/voice.module.js";
import { VoiceSessionStore } from "./voice/voice-session-store.js";
import { HealthModule } from "./health/health.module.js";
import { TwilioVerifier } from "./webhooks/twilio-verifier.js";

async function bootstrap(): Promise<void> {
  const env = loadEnv();

  initOtel({
    serviceName: "vex-api",
    serviceNamespace: env.OTEL_SERVICE_NAMESPACE,
    ...(env.OTEL_EXPORTER_OTLP_ENDPOINT
      ? { otlpEndpoint: env.OTEL_EXPORTER_OTLP_ENDPOINT }
      : {}),
  });

  if (!env.RESEND_WEBHOOK_SECRET) {
    throw new Error("RESEND_WEBHOOK_SECRET is required to start the API");
  }
  if (!env.TWILIO_AUTH_TOKEN) {
    throw new Error("TWILIO_AUTH_TOKEN is required to start the API");
  }
  if (!env.NEXTAUTH_SECRET) {
    throw new Error("NEXTAUTH_SECRET is required to start the API");
  }

  const db = createDb(env.APPLICATION_DATABASE_URL);
  const rawEventRepository = new RawEventRepository();
  const approvalRepository = new ApprovalRepository();
  const agentRunRepository = new AgentRunRepository();
  const activityRepository = new ActivityRepository();
  const eventRepository = new EventRepository();
  const organizationRepository = new OrganizationRepository();
  const contactRepository = new ContactRepository();
  const summaryRepository = new SummaryRepository();
  const touchpointRepository = new TouchpointRepository();
  const workspaceRepository = new WorkspaceRepository();
  const redis = createRedisConnection(env.REDIS_URL);
  const queues = createQueues(redis);

  const costLedger = new InMemoryCostLedger();
  const openai = new OpenAIAdapter({ apiKey: env.OPENAI_API_KEY, costLedger });
  const anthropic = new AnthropicAdapter({ apiKey: env.ANTHROPIC_API_KEY, costLedger });
  const retrieval = new RetrievalService();

  // Sprint 12 — Twilio + S3 for outbound calls. The Twilio client is
  // only constructed when the three Twilio env vars are present, so a
  // workspace that isn't using outbound calls keeps booting cleanly.
  // When unset the CallsModule stays unregistered.
  const twilioConfigured =
    env.TWILIO_ACCOUNT_SID && env.TWILIO_AUTH_TOKEN && env.TWILIO_PHONE_NUMBER;
  const twilio = twilioConfigured
    ? createTwilioClient({
        accountSid: env.TWILIO_ACCOUNT_SID!,
        authToken: env.TWILIO_AUTH_TOKEN!,
        fromNumber: env.TWILIO_PHONE_NUMBER!,
      })
    : null;
  const twilioVerifier = env.TWILIO_AUTH_TOKEN
    ? new TwilioVerifier({ authToken: env.TWILIO_AUTH_TOKEN })
    : null;
  const s3 = new S3Uploader({
    region: env.S3_REGION,
    bucket: env.S3_BUCKET,
    accessKeyId: env.S3_ACCESS_KEY_ID,
    secretAccessKey: env.S3_SECRET_ACCESS_KEY,
    ...(env.S3_ENDPOINT ? { endpoint: env.S3_ENDPOINT } : {}),
  });

  const voiceSessionStore = new VoiceSessionStore(redis);
  const voiceContextBuilder = new VoiceContextBuilder({
    organizations: organizationRepository,
    contacts: contactRepository,
    summaries: summaryRepository,
    touchpoints: touchpointRepository,
    approvals: approvalRepository,
  });

  // Temporal client — best-effort. If the Temporal cluster isn't reachable
  // at boot the API still starts; ApprovalsService will log signal failures
  // but won't fail the request.
  let temporal: Awaited<ReturnType<typeof createTemporalClient>> | null = null;
  try {
    temporal = await createTemporalClient({
      address: env.TEMPORAL_ADDRESS,
      namespace: env.TEMPORAL_NAMESPACE,
    });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn(
      `Temporal client unavailable at boot: ${(err as Error).message}; signals will be skipped`,
    );
  }

  const app = await NestFactory.create<NestFastifyApplication>(
    AppModule.register({
      nextAuthSecret: env.NEXTAUTH_SECRET,
      webhooks: WebhooksModule.register({
        db,
        rawEventRepository,
        normalizationQueue: queues.normalization,
        resendSecret: env.RESEND_WEBHOOK_SECRET,
        twilioAuthToken: env.TWILIO_AUTH_TOKEN,
        resolveTenant: () => "01HSEEDWRK0000000000000001",
      }),
      query: QueryModule.register({ db, retrieval, openai, anthropic }),
      approvals: ApprovalsModule.register({
        db,
        approvals: approvalRepository,
        events: eventRepository,
        executorQueue: queues.approvalExecutor,
        temporal: temporal?.client ?? null,
      }),
      agentRuns: AgentRunsModule.register({
        db,
        agentRuns: agentRunRepository,
        approvals: approvalRepository,
      }),
      brief: BriefModule.register({
        db,
        summaries: summaryRepository,
        approvals: approvalRepository,
      }),
      contacts: ContactsModule.register({
        db,
        contacts: contactRepository,
        events: eventRepository,
      }),
      deals: DealsModule.register({ db }),
      admin: AdminModule.register({
        db,
        workspaces: workspaceRepository,
        events: eventRepository,
        evalResultsPath:
          process.env["EVAL_RESULTS_PATH"] ??
          resolve(process.cwd(), "evals/results/latest.json"),
      }),
      ...(temporal && twilio && twilioVerifier
        ? {
            calls: CallsModule.register({
              db,
              workspaces: workspaceRepository,
              contacts: contactRepository,
              agentRuns: agentRunRepository,
              approvals: approvalRepository,
              activities: activityRepository,
              summaries: summaryRepository,
              events: eventRepository,
              temporal: temporal.client,
              twilio,
              twilioVerifier,
              s3,
              taskQueue: TEMPORAL_TASK_QUEUE,
            }),
          }
        : {}),
      voice: VoiceModule.register({
        db,
        openai,
        sessionStore: voiceSessionStore,
        contextBuilder: voiceContextBuilder,
        transcriptQueue: queues.transcript,
      }),
      health: HealthModule.register({
        db,
        redis,
        temporal: temporal?.client ?? null,
        queues,
      }),
    }),
    new FastifyAdapter({ logger: { level: env.LOG_LEVEL } }),
    { rawBody: true },
  );

  const shutdown = async (): Promise<void> => {
    await app.close();
    await queues.close();
    redis.disconnect();
    if (temporal) await temporal.close();
    await shutdownOtel();
  };
  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());

  await app.listen(env.PORT, "0.0.0.0");
}

void bootstrap();
