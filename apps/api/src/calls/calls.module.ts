import { Module, type DynamicModule } from "@nestjs/common";
import type { Client as TemporalClient } from "@temporalio/client";
import type {
  ActivityRepository,
  AgentRunRepository,
  ApprovalRepository,
  ContactRepository,
  Db,
  EventRepository,
  SummaryRepository,
  TouchpointRepository,
  WorkspaceRepository,
} from "@vex/db";
import type {
  S3Uploader,
  TwilioClient,
  TwilioVoiceSdkDeps,
  createResendClient,
} from "@vex/integrations";

export type ResendClient = ReturnType<typeof createResendClient>;
import type { TwilioVerifier } from "../webhooks/twilio-verifier.js";
import { CallsController } from "./calls.controller.js";
import { CallsService } from "./calls.service.js";
import {
  CALLS_ACTIVITIES_REPO,
  CALLS_AGENT_RUNS_REPO,
  CALLS_APP_BASE_URL,
  CALLS_RESEND_CLIENT,
  CALLS_APPROVALS_REPO,
  CALLS_CONTACTS_REPO,
  CALLS_DB_CLIENT,
  CALLS_EVENTS_REPO,
  CALLS_S3_UPLOADER,
  CALLS_SUMMARIES_REPO,
  CALLS_TASK_QUEUE,
  CALLS_TOUCHPOINTS_REPO,
  CALLS_TEMPORAL_CLIENT,
  CALLS_TWILIO_CLIENT,
  CALLS_TWILIO_VERIFIER,
  CALLS_VOICE_LISTENER_CONFIG,
  CALLS_VOICE_SDK_CONFIG,
  CALLS_WORKSPACES_REPO,
} from "./tokens.js";

/**
 * Sprint K — AI escalation-listener wiring. `enabled: false` (the
 * default) keeps the Sprint J TwiML unchanged. When enabled the
 * TwiML emits `<Start><Stream url={streamUrl}/>` before the
 * conference so the callee-leg audio forks to our WS bridge.
 */
export interface VoiceListenerConfig {
  enabled: boolean;
  /** Full wss:// URL Twilio hits for the Media Stream. */
  streamUrl: string;
}

/**
 * Sprint J — Twilio Voice SDK creds resolved at boot. `null` signals
 * the three env vars weren't set; the join endpoint short-circuits to
 * 503 in that case (operator gets a clear error instead of a broken
 * Voice SDK session).
 */
export type VoiceSdkConfig =
  | ({ accountSid: string } & TwilioVoiceSdkDeps)
  | null;

export interface CallsModuleConfig {
  db: Db;
  workspaces: WorkspaceRepository;
  contacts: ContactRepository;
  agentRuns: AgentRunRepository;
  approvals: ApprovalRepository;
  activities: ActivityRepository;
  touchpoints: TouchpointRepository;
  summaries: SummaryRepository;
  events: EventRepository;
  /**
   * Temporal client — null when the Temporal cluster is unreachable at
   * boot. Service methods that drive workflows (initiateCall,
   * mintJoinToken status lookups) 503 in that case; demo-call and
   * other non-workflow paths keep working.
   */
  temporal: TemporalClient | null;
  twilio: TwilioClient;
  twilioVerifier: TwilioVerifier;
  s3: S3Uploader;
  voiceSdk: VoiceSdkConfig;
  voiceListener: VoiceListenerConfig;
  /** Resend client for demo email sends. Null disables /calls/demo-email. */
  resend: ResendClient | null;
  /** Public base URL of apps/api — used by the demo-call TwiML. */
  appBaseUrl: string;
  /** Temporal task queue the outbound-call workflow runs on. */
  taskQueue: string;
}

@Module({})
export class CallsModule {
  static register(config: CallsModuleConfig): DynamicModule {
    return {
      module: CallsModule,
      controllers: [CallsController],
      providers: [
        { provide: CALLS_DB_CLIENT, useFactory: () => config.db },
        { provide: CALLS_WORKSPACES_REPO, useFactory: () => config.workspaces },
        { provide: CALLS_CONTACTS_REPO, useFactory: () => config.contacts },
        { provide: CALLS_AGENT_RUNS_REPO, useFactory: () => config.agentRuns },
        { provide: CALLS_APPROVALS_REPO, useFactory: () => config.approvals },
        { provide: CALLS_ACTIVITIES_REPO, useFactory: () => config.activities },
        { provide: CALLS_TOUCHPOINTS_REPO, useFactory: () => config.touchpoints },
        { provide: CALLS_SUMMARIES_REPO, useFactory: () => config.summaries },
        { provide: CALLS_EVENTS_REPO, useFactory: () => config.events },
        { provide: CALLS_TEMPORAL_CLIENT, useFactory: () => config.temporal },
        { provide: CALLS_TWILIO_CLIENT, useFactory: () => config.twilio },
        { provide: CALLS_TWILIO_VERIFIER, useFactory: () => config.twilioVerifier },
        { provide: CALLS_S3_UPLOADER, useFactory: () => config.s3 },
        { provide: CALLS_TASK_QUEUE, useFactory: () => config.taskQueue },
        { provide: CALLS_VOICE_SDK_CONFIG, useFactory: () => config.voiceSdk },
        { provide: CALLS_VOICE_LISTENER_CONFIG, useFactory: () => config.voiceListener },
        { provide: CALLS_APP_BASE_URL, useFactory: () => config.appBaseUrl },
        { provide: CALLS_RESEND_CLIENT, useFactory: () => config.resend },
        CallsService,
      ],
    };
  }
}
