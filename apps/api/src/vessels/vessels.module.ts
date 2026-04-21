import { Module, type DynamicModule } from "@nestjs/common";
import type { Db, VesselRepository } from "@vex/db";
import {
  VESSELS_DB_CLIENT,
  VESSELS_REPO,
  VesselsController,
} from "./vessels.controller.js";

export interface VesselsModuleConfig {
  db: Db;
  vessels: VesselRepository;
}

@Module({})
export class VesselsModule {
  static register(config: VesselsModuleConfig): DynamicModule {
    return {
      module: VesselsModule,
      controllers: [VesselsController],
      providers: [
        { provide: VESSELS_DB_CLIENT, useFactory: () => config.db },
        { provide: VESSELS_REPO, useFactory: () => config.vessels },
      ],
    };
  }
}
