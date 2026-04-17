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
import type { S3Uploader, TwilioClient } from "@vex/integrations";
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
  CALLS_WORKSPACES_REPO,
} from "./tokens.js";

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
        { provide: CALLS_DB_CLIENT, useValue: config.db },
        { provide: CALLS_WORKSPACES_REPO, useValue: config.workspaces },
        { provide: CALLS_CONTACTS_REPO, useValue: config.contacts },
        { provide: CALLS_AGENT_RUNS_REPO, useValue: config.agentRuns },
        { provide: CALLS_APPROVALS_REPO, useValue: config.approvals },
        { provide: CALLS_ACTIVITIES_REPO, useValue: config.activities },
        { provide: CALLS_SUMMARIES_REPO, useValue: config.summaries },
        { provide: CALLS_EVENTS_REPO, useValue: config.events },
        { provide: CALLS_TEMPORAL_CLIENT, useValue: config.temporal },
        { provide: CALLS_TWILIO_CLIENT, useValue: config.twilio },
        { provide: CALLS_TWILIO_VERIFIER, useValue: config.twilioVerifier },
        { provide: CALLS_S3_UPLOADER, useValue: config.s3 },
        { provide: CALLS_TASK_QUEUE, useValue: config.taskQueue },
        CallsService,
      ],
    };
  }
}
