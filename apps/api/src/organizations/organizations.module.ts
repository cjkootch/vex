import { Module, type DynamicModule } from "@nestjs/common";
import type { Db } from "@vex/db";
import {
  ORGANIZATIONS_DB_CLIENT,
  OrganizationsController,
} from "./organizations.controller.js";

export interface OrganizationsModuleConfig {
  db: Db;
}

/**
 * Dynamic module for the /organizations read endpoints. Mirrors the
 * DealsModule / BriefModule shape — controller injects the Db via a
 * symbol token so tests can swap in a mocked client.
 */
@Module({})
export class OrganizationsModule {
  static register(config: OrganizationsModuleConfig): DynamicModule {
    return {
      module: OrganizationsModule,
      controllers: [OrganizationsController],
      providers: [{ provide: ORGANIZATIONS_DB_CLIENT, useValue: config.db }],
    };
  }
}
