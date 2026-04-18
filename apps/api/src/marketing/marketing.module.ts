import { Module, type DynamicModule } from "@nestjs/common";
import type { Client as TemporalClient } from "@temporalio/client";
import type {
  ApprovalRepository,
  CampaignEnrollmentRepository,
  CampaignRepository,
  CampaignStepRepository,
  Db,
  EventRepository,
  TouchpointRepository,
} from "@vex/db";
import {
  MARKETING_APPROVALS_REPO,
  MARKETING_CAMPAIGNS_REPO,
  MARKETING_DB_CLIENT,
  MARKETING_ENROLLMENTS_REPO,
  MARKETING_EVENTS_REPO,
  MARKETING_STEPS_REPO,
  MARKETING_TEMPORAL_CLIENT,
  MARKETING_TOUCHPOINTS_REPO,
  MarketingController,
} from "./marketing.controller.js";

export interface MarketingModuleConfig {
  db: Db;
  campaigns: CampaignRepository;
  touchpoints: TouchpointRepository;
  steps: CampaignStepRepository;
  enrollments: CampaignEnrollmentRepository;
  approvals: ApprovalRepository;
  events: EventRepository;
  /**
   * Best-effort Temporal client. Sprint F moves the actual workflow
   * start to the approval executor, so this stays here purely for
   * future read-surface endpoints that might signal running
   * workflows (e.g. a "pause enrollment" button). Can be null.
   */
  temporal: TemporalClient | null;
}

@Module({})
export class MarketingModule {
  static register(config: MarketingModuleConfig): DynamicModule {
    return {
      module: MarketingModule,
      controllers: [MarketingController],
      providers: [
        { provide: MARKETING_DB_CLIENT, useFactory: () => config.db },
        { provide: MARKETING_CAMPAIGNS_REPO, useFactory: () => config.campaigns },
        { provide: MARKETING_TOUCHPOINTS_REPO, useFactory: () => config.touchpoints },
        { provide: MARKETING_STEPS_REPO, useFactory: () => config.steps },
        { provide: MARKETING_ENROLLMENTS_REPO, useFactory: () => config.enrollments },
        { provide: MARKETING_TEMPORAL_CLIENT, useFactory: () => config.temporal },
        { provide: MARKETING_APPROVALS_REPO, useFactory: () => config.approvals },
        { provide: MARKETING_EVENTS_REPO, useFactory: () => config.events },
      ],
    };
  }
}
