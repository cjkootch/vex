import { Module, type DynamicModule } from "@nestjs/common";
import type { Db, EventRepository, OrganizationRepository } from "@vex/db";
import {
  ORGANIZATIONS_DB_CLIENT,
  ORGANIZATIONS_EVENT_REPO,
  ORGANIZATIONS_REPO,
  OrganizationsController,
} from "./organizations.controller.js";

export interface OrganizationsModuleConfig {
  db: Db;
  organizations: OrganizationRepository;
  events: EventRepository;
}

@Module({})
export class OrganizationsModule {
  static register(config: OrganizationsModuleConfig): DynamicModule {
    return {
      module: OrganizationsModule,
      controllers: [OrganizationsController],
      providers: [
        { provide: ORGANIZATIONS_DB_CLIENT, useValue: config.db },
        { provide: ORGANIZATIONS_REPO, useValue: config.organizations },
        { provide: ORGANIZATIONS_EVENT_REPO, useValue: config.events },
      ],
    };
  }
}
