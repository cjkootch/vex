import { Module, type DynamicModule } from "@nestjs/common";
import type {
  ApprovalRepository,
  CounterpartyRiskRepository,
  Db,
  EventRepository,
  FreightRateRepository,
  FuelDealParticipantRepository,
  FuelDealRepository,
  FuelMarketRateRepository,
  OrganizationRepository,
  VesselRepository,
} from "@vex/db";
import {
  DEALS_APPROVAL_REPO,
  DEALS_COUNTERPARTY_REPO,
  DEALS_DB_CLIENT,
  DEALS_EVENT_REPO,
  DEALS_FREIGHT_RATE_REPO,
  DEALS_MARKET_RATE_REPO,
  DEALS_ORGS_REPO,
  DEALS_PARTICIPANT_REPO,
  DEALS_REPO,
  DEALS_VESSEL_REPO,
  DealsController,
} from "./deals.controller.js";

export interface DealsModuleConfig {
  db: Db;
  deals: FuelDealRepository;
  events: EventRepository;
  approvals: ApprovalRepository;
  organizations: OrganizationRepository;
  marketRates: FuelMarketRateRepository;
  participants: FuelDealParticipantRepository;
  counterparty: CounterpartyRiskRepository;
  vessels: VesselRepository;
  freightRates: FreightRateRepository;
}

/**
 * Dynamic module for /deals. Sprint 14 added POST + PATCH write
 * endpoints; Group 3 adds POST /:id/status/request which needs the
 * ApprovalRepository so it can land a pending T2 approval row for
 * approved/cancelled transitions. The edit endpoint added in the
 * CRM-edit feature reuses OrganizationRepository to validate a new
 * buyer_org_id when the caller changes it.
 */
@Module({})
export class DealsModule {
  static register(config: DealsModuleConfig): DynamicModule {
    return {
      module: DealsModule,
      controllers: [DealsController],
      providers: [
        { provide: DEALS_DB_CLIENT, useFactory: () => config.db },
        { provide: DEALS_REPO, useFactory: () => config.deals },
        { provide: DEALS_EVENT_REPO, useFactory: () => config.events },
        { provide: DEALS_APPROVAL_REPO, useFactory: () => config.approvals },
        { provide: DEALS_ORGS_REPO, useFactory: () => config.organizations },
        { provide: DEALS_MARKET_RATE_REPO, useFactory: () => config.marketRates },
        { provide: DEALS_PARTICIPANT_REPO, useFactory: () => config.participants },
        { provide: DEALS_COUNTERPARTY_REPO, useFactory: () => config.counterparty },
        { provide: DEALS_VESSEL_REPO, useFactory: () => config.vessels },
        { provide: DEALS_FREIGHT_RATE_REPO, useFactory: () => config.freightRates },
      ],
    };
  }
}
