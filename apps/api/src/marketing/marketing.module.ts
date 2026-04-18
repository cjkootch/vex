import { Module, type DynamicModule } from "@nestjs/common";
import type {
  CampaignEnrollmentRepository,
  CampaignRepository,
  CampaignStepRepository,
  Db,
  TouchpointRepository,
} from "@vex/db";
import {
  MARKETING_CAMPAIGNS_REPO,
  MARKETING_DB_CLIENT,
  MARKETING_ENROLLMENTS_REPO,
  MARKETING_STEPS_REPO,
  MARKETING_TOUCHPOINTS_REPO,
  MarketingController,
} from "./marketing.controller.js";

export interface MarketingModuleConfig {
  db: Db;
  campaigns: CampaignRepository;
  touchpoints: TouchpointRepository;
  steps: CampaignStepRepository;
  enrollments: CampaignEnrollmentRepository;
}

/**
 * Dynamic module for /marketing. Sprint C adds plan authoring
 * (campaigns/:id/steps) + enrollment (campaigns/:id/enroll,
 * enrollments). Read endpoints for campaign rollups remain.
 */
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
      ],
    };
  }
}
