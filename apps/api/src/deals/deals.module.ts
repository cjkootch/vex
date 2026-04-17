import { Module, type DynamicModule } from "@nestjs/common";
import type { Db } from "@vex/db";
import { DEALS_DB_CLIENT, DealsController } from "./deals.controller.js";

export interface DealsModuleConfig {
  db: Db;
}

/**
 * Dynamic module for the /deals read endpoints. Thin wrapper — the
 * controller talks to the schema directly for the buyer-join, so no
 * service layer is needed yet. When write endpoints land (POST /deals,
 * PATCH /deals/:id) split a DealsService into its own file.
 */
@Module({})
export class DealsModule {
  static register(config: DealsModuleConfig): DynamicModule {
    return {
      module: DealsModule,
      controllers: [DealsController],
      providers: [{ provide: DEALS_DB_CLIENT, useValue: config.db }],
    };
  }
}
