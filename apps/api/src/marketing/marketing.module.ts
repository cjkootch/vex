import { Module, type DynamicModule } from "@nestjs/common";
import type {
  CampaignRepository,
  Db,
  EventRepository,
  SummaryRepository,
  TouchpointRepository,
} from "@vex/db";
import { MarketingController } from "./marketing.controller.js";
import { MarketingService } from "./marketing.service.js";
import {
  MARKETING_CAMPAIGN_REPO,
  MARKETING_DB_CLIENT,
  MARKETING_EVENT_REPO,
  MARKETING_SUMMARY_REPO,
  MARKETING_TOUCHPOINT_REPO,
} from "./tokens.js";

export interface MarketingModuleConfig {
  db: Db;
  summaries: SummaryRepository;
  campaigns: CampaignRepository;
  events: EventRepository;
  touchpoints: TouchpointRepository;
}

@Module({})
export class MarketingModule {
  static register(config: MarketingModuleConfig): DynamicModule {
    return {
      module: MarketingModule,
      controllers: [MarketingController],
      providers: [
        { provide: MARKETING_DB_CLIENT, useValue: config.db },
        { provide: MARKETING_SUMMARY_REPO, useValue: config.summaries },
        { provide: MARKETING_CAMPAIGN_REPO, useValue: config.campaigns },
        { provide: MARKETING_EVENT_REPO, useValue: config.events },
        { provide: MARKETING_TOUCHPOINT_REPO, useValue: config.touchpoints },
        MarketingService,
      ],
    };
  }
}
