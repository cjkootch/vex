import { Module, type DynamicModule } from "@nestjs/common";
import type {
  ApprovalRepository,
  Db,
  EventRepository,
  FuelDealRepository,
} from "@vex/db";
import {
  DEALS_APPROVAL_REPO,
  DEALS_DB_CLIENT,
  DEALS_EVENT_REPO,
  DEALS_REPO,
  DealsController,
} from "./deals.controller.js";

export interface DealsModuleConfig {
  db: Db;
  deals: FuelDealRepository;
  events: EventRepository;
  approvals: ApprovalRepository;
}

/**
 * Dynamic module for /deals. Sprint 14 added POST + PATCH write
 * endpoints; Group 3 adds POST /:id/status/request which needs the
 * ApprovalRepository so it can land a pending T2 approval row for
 * approved/cancelled transitions.
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
        { provide: DEALS_APPROVAL_REPO, useValue: config.approvals },
      ],
    };
  }
}
