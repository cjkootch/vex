import { Module, type DynamicModule } from "@nestjs/common";
import type {
  Db,
  EventRepository,
  OrganizationProductRepository,
  OrganizationRelationshipRepository,
  OrganizationRepository,
} from "@vex/db";
import {
  ORGANIZATIONS_DB_CLIENT,
  ORGANIZATIONS_EVENT_REPO,
  ORGANIZATIONS_PRODUCTS_REPO,
  ORGANIZATIONS_RELATIONSHIPS_REPO,
  ORGANIZATIONS_REPO,
  OrganizationsController,
} from "./organizations.controller.js";

export interface OrganizationsModuleConfig {
  db: Db;
  organizations: OrganizationRepository;
  events: EventRepository;
  orgProducts: OrganizationProductRepository;
  orgRelationships: OrganizationRelationshipRepository;
}

@Module({})
export class OrganizationsModule {
  static register(config: OrganizationsModuleConfig): DynamicModule {
    return {
      module: OrganizationsModule,
      controllers: [OrganizationsController],
      providers: [
        { provide: ORGANIZATIONS_DB_CLIENT, useFactory: () => config.db },
        { provide: ORGANIZATIONS_REPO, useFactory: () => config.organizations },
        { provide: ORGANIZATIONS_EVENT_REPO, useFactory: () => config.events },
        {
          provide: ORGANIZATIONS_PRODUCTS_REPO,
          useFactory: () => config.orgProducts,
        },
        {
          provide: ORGANIZATIONS_RELATIONSHIPS_REPO,
          useFactory: () => config.orgRelationships,
        },
      ],
    };
  }
}
