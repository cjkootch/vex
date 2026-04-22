import { Module, type DynamicModule } from "@nestjs/common";
import type { Db, PortRepository } from "@vex/db";
import {
  PORTS_DB_CLIENT,
  PORTS_REPO,
  PortsController,
} from "./ports.controller.js";

export interface PortsModuleConfig {
  db: Db;
  ports: PortRepository;
}

@Module({})
export class PortsModule {
  static register(config: PortsModuleConfig): DynamicModule {
    return {
      module: PortsModule,
      controllers: [PortsController],
      providers: [
        { provide: PORTS_DB_CLIENT, useFactory: () => config.db },
        { provide: PORTS_REPO, useFactory: () => config.ports },
      ],
    };
  }
}
