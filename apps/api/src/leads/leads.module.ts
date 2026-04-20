import { Module, type DynamicModule } from "@nestjs/common";
import type { Db } from "@vex/db";
import { LeadsController } from "./leads.controller.js";
import { LeadsService } from "./leads.service.js";
import { LEADS_DB_CLIENT } from "./tokens.js";

export interface LeadsModuleConfig {
  db: Db;
}

@Module({})
export class LeadsModule {
  static register(config: LeadsModuleConfig): DynamicModule {
    return {
      module: LeadsModule,
      controllers: [LeadsController],
      providers: [
        { provide: LEADS_DB_CLIENT, useFactory: () => config.db },
        LeadsService,
      ],
    };
  }
}
