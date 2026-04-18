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
  WorkspaceRepository,
} from "@vex/db";
import type { S3Uploader, TwilioClient, TwilioVoiceSdkDeps } from "@vex/integrations";
import type { TwilioVerifier } from "../webhooks/twilio-verifier.js";
import { CallsController } from "./calls.controller.js";
import { CallsService } from "./calls.service.js";
import {
  CALLS_ACTIVITIES_REPO,
  CALLS_AGENT_RUNS_REPO,
  CALLS_APPROVALS_REPO,
  CALLS_CONTACTS_REPO,
  CALLS_DB_CLIENT,
  CALLS_EVENTS_REPO,
  CALLS_S3_UPLOADER,
  CALLS_SUMMARIES_REPO,
  CALLS_TASK_QUEUE,
  CALLS_TEMPORAL_CLIENT,
  CALLS_TWILIO_CLIENT,
  CALLS_TWILIO_VERIFIER,
  CALLS_VOICE_SDK_CONFIG,
  CALLS_WORKSPACES_REPO,
} from "./tokens.js";

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
  summaries: SummaryRepository;
  events: EventRepository;
  temporal: TemporalClient;
  twilio: TwilioClient;
  twilioVerifier: TwilioVerifier;
  s3: S3Uploader;
  voiceSdk: VoiceSdkConfig;
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
        { provide: CALLS_SUMMARIES_REPO, useFactory: () => config.summaries },
        { provide: CALLS_EVENTS_REPO, useFactory: () => config.events },
        { provide: CALLS_TEMPORAL_CLIENT, useFactory: () => config.temporal },
        { provide: CALLS_TWILIO_CLIENT, useFactory: () => config.twilio },
        { provide: CALLS_TWILIO_VERIFIER, useFactory: () => config.twilioVerifier },
        { provide: CALLS_S3_UPLOADER, useFactory: () => config.s3 },
        { provide: CALLS_TASK_QUEUE, useFactory: () => config.taskQueue },
        { provide: CALLS_VOICE_SDK_CONFIG, useFactory: () => config.voiceSdk },
        CallsService,
      ],
    };
  }
}
