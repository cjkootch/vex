import { Module, type DynamicModule } from "@nestjs/common";
import type { CampaignRepository, Db, TouchpointRepository } from "@vex/db";
import {
  MARKETING_CAMPAIGNS_REPO,
  MARKETING_DB_CLIENT,
  MARKETING_TOUCHPOINTS_REPO,
  MarketingController,
} from "./marketing.controller.js";

export interface MarketingModuleConfig {
  db: Db;
  campaigns: CampaignRepository;
  touchpoints: TouchpointRepository;
}

/**
 * Dynamic module for /marketing. Read-only in this sprint — list +
 * detail endpoints for campaigns with touchpoint rollups.
 */
@Module({})
export class MarketingModule {
  static register(config: MarketingModuleConfig): DynamicModule {
    return {
      module: MarketingModule,
      controllers: [MarketingController],
      providers: [
        { provide: MARKETING_DB_CLIENT, useValue: config.db },
        { provide: MARKETING_CAMPAIGNS_REPO, useValue: config.campaigns },
        { provide: MARKETING_TOUCHPOINTS_REPO, useValue: config.touchpoints },
      ],
    };
  }
}
