import { Module, type DynamicModule } from "@nestjs/common";
import type { Db, EventRepository, FuelDealRepository } from "@vex/db";
import {
  DEALS_DB_CLIENT,
  DEALS_EVENT_REPO,
  DEALS_REPO,
  DealsController,
} from "./deals.controller.js";

export interface DealsModuleConfig {
  db: Db;
  deals: FuelDealRepository;
  events: EventRepository;
}

/**
 * Dynamic module for /deals. Sprint 14 added POST + PATCH write
 * endpoints, so the controller now injects the repo and event
 * repository alongside the raw Db client (the list/detail endpoints
 * still go straight to drizzle for the buyer-name join).
 */
@Module({})
export class DealsModule {
  static register(config: DealsModuleConfig): DynamicModule {
    return {
      module: DealsModule,
      controllers: [DealsController],
      providers: [
        { provide: DEALS_DB_CLIENT, useValue: config.db },
        { provide: DEALS_REPO, useValue: config.deals },
        { provide: DEALS_EVENT_REPO, useValue: config.events },
      ],
    };
  }
}
