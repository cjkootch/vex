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
  CampaignEnrollmentRepository,
  CampaignRepository,
  CampaignStepRepository,
  ContactOrgMembershipRepository,
  ContactRepository,
  EventRepository,
  FuelDealRepository,
  OrganizationRepository,
  RawEventRepository,
  RetrievalService,
  SummaryRepository,
  FollowUpRepository,
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
  createResendClient,
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
import { CommunicationsModule } from "./communications/communications.module.js";
import { FollowUpsModule } from "./follow-ups/follow-ups.module.js";
import { CallsModule } from "./calls/calls.module.js";
import { CallsService } from "./calls/calls.service.js";
import { VoiceStreamServer } from "./calls/voice-stream-server.js";
import { ContactsModule } from "./contacts/contacts.module.js";
import { DealsModule } from "./deals/deals.module.js";
import { EventsModule } from "./events/events.module.js";
import { MarketingModule } from "./marketing/marketing.module.js";
import { OrganizationsModule } from "./organizations/organizations.module.js";
import { SearchModule } from "./search/search.module.js";
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
  const followUpRepository = new FollowUpRepository();
  const workspaceRepository = new WorkspaceRepository();
  const fuelDealRepository = new FuelDealRepository();
  const campaignRepository = new CampaignRepository();
  const campaignStepRepository = new CampaignStepRepository();
  const campaignEnrollmentRepository = new CampaignEnrollmentRepository();
  const contactMembershipRepository = new ContactOrgMembershipRepository();
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
        whatsappFrom: env.TWILIO_WHATSAPP_FROM,
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

  // Resend — demo email sends. Null when the API key isn't set so the
  // /calls/demo-email endpoint 503s cleanly.
  const resend = env.RESEND_API_KEY
    ? createResendClient({
        apiKey: env.RESEND_API_KEY,
        defaultFrom: env.RESEND_DEFAULT_FROM,
      })
    : null;

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
  // Race against a short deadline so a missing Temporal Cloud
  // endpoint can't stall startup for 60s (Fly healthcheck window).
  const TEMPORAL_BOOT_TIMEOUT_MS = 5_000;
  let temporal: Awaited<ReturnType<typeof createTemporalClient>> | null = null;
  try {
    temporal = await Promise.race([
      createTemporalClient({
        address: env.TEMPORAL_ADDRESS,
        namespace: env.TEMPORAL_NAMESPACE,
      }),
      new Promise<never>((_, reject) =>
        setTimeout(
          () => reject(new Error(`timeout ${TEMPORAL_BOOT_TIMEOUT_MS}ms`)),
          TEMPORAL_BOOT_TIMEOUT_MS,
        ),
      ),
    ]);
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
      communications: CommunicationsModule.register({
        db,
        touchpoints: touchpointRepository,
        activities: activityRepository,
      }),
      followUps: FollowUpsModule.register({
        db,
        followUps: followUpRepository,
      }),
      contacts: ContactsModule.register({
        db,
        contacts: contactRepository,
        memberships: contactMembershipRepository,
        events: eventRepository,
      }),
      deals: DealsModule.register({
        db,
        deals: fuelDealRepository,
        events: eventRepository,
        approvals: approvalRepository,
        organizations: organizationRepository,
      }),
      events: EventsModule.register({ db }),
      marketing: MarketingModule.register({
        db,
        campaigns: campaignRepository,
        touchpoints: touchpointRepository,
        steps: campaignStepRepository,
        enrollments: campaignEnrollmentRepository,
        approvals: approvalRepository,
        events: eventRepository,
        temporal: temporal?.client ?? null,
      }),
      organizations: OrganizationsModule.register({
        db,
        organizations: organizationRepository,
        events: eventRepository,
      }),
      search: SearchModule.register({ db }),
      admin: AdminModule.register({
        db,
        workspaces: workspaceRepository,
        events: eventRepository,
        evalResultsPath:
          process.env["EVAL_RESULTS_PATH"] ??
          resolve(process.cwd(), "evals/results/latest.json"),
      }),
      ...(twilio && twilioVerifier
        ? {
            calls: CallsModule.register({
              db,
              workspaces: workspaceRepository,
              contacts: contactRepository,
              agentRuns: agentRunRepository,
              approvals: approvalRepository,
              activities: activityRepository,
              touchpoints: touchpointRepository,
              summaries: summaryRepository,
              events: eventRepository,
              temporal: temporal?.client ?? null,
              twilio,
              twilioVerifier,
              s3,
              voiceSdk:
                env.TWILIO_API_KEY && env.TWILIO_API_SECRET && env.TWILIO_TWIML_APP_SID
                  ? {
                      accountSid: env.TWILIO_ACCOUNT_SID!,
                      apiKey: env.TWILIO_API_KEY,
                      apiSecret: env.TWILIO_API_SECRET,
                      twimlAppSid: env.TWILIO_TWIML_APP_SID,
                    }
                  : null,
              voiceListener: {
                enabled: env.VEX_AI_VOICE_ENABLED && Boolean(env.APP_BASE_URL),
                streamUrl: env.APP_BASE_URL
                  ? `${env.APP_BASE_URL.replace(/^http/i, "ws").replace(/\/$/, "")}/calls/twilio/stream`
                  : "",
              },
              appBaseUrl: env.APP_BASE_URL ?? "",
              resend,
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

  // Sprint K — voice-bridge WS server. Only instantiated when the
  // feature flag is on AND CallsModule is registered (which requires
  // Twilio creds + Temporal reachable). When disabled, Twilio upgrade
  // attempts against /calls/twilio/stream receive an immediate 503
  // so the call transparently falls back to conference-only.
  let voiceStreamServer: VoiceStreamServer | null = null;

  const shutdown = async (): Promise<void> => {
    if (voiceStreamServer) voiceStreamServer.close();
    await app.close();
    await queues.close();
    redis.disconnect();
    if (temporal) await temporal.close();
    await shutdownOtel();
  };
  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());

  await app.listen(env.PORT, "0.0.0.0");

  // Attach the WS bridge AFTER Fastify has bound the HTTP server.
  // Before `.listen()` the underlying Node server may not yet route
  // `upgrade` events reliably — attaching here guarantees we hook the
  // actual bound listener.
  if (env.VEX_AI_VOICE_ENABLED && twilio && twilioVerifier) {
    try {
      const callsService = app.get(CallsService, { strict: false });
      voiceStreamServer = new VoiceStreamServer({
        enabled: true,
        openaiApiKey: env.OPENAI_API_KEY,
        model: env.OPENAI_REALTIME_CALL_MODEL,
        voice: env.OPENAI_REALTIME_CALL_VOICE,
        log: (level, msg, meta) => {
          const logger = app.getHttpAdapter().getInstance().log;
          const fn = level === "error" ? logger.error.bind(logger) : logger.info.bind(logger);
          fn({ ...meta, msg });
        },
        onEscalate: async ({ workflowId, tenantId, reason }) => {
          await callsService.requestHumanBackup({
            tenantId,
            workflowId,
            reason,
          });
        },
      });
      voiceStreamServer.attach(
        app.getHttpAdapter().getInstance().server,
      );
    } catch (err) {
      // Non-fatal: without the bridge the call falls back to the
      // conference-only TwiML, which still works end-to-end.
      // eslint-disable-next-line no-console
      console.warn(
        `voice bridge mount failed: ${(err as Error).message} — continuing without AI listener`,
      );
    }
  } else {
    // eslint-disable-next-line no-console
    console.warn(
      `voice bridge skipped — enabled=${env.VEX_AI_VOICE_ENABLED} twilio=${Boolean(twilio)} verifier=${Boolean(twilioVerifier)}`,
    );
  }
}

void bootstrap();
