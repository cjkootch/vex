import { Module, type DynamicModule } from "@nestjs/common";
import type { Db, SignalRepository } from "@vex/db";
import { SignalsController } from "./signals.controller.js";
import { SIGNALS_DB_CLIENT, SIGNALS_REPO } from "./tokens.js";

export interface SignalsModuleConfig {
  db: Db;
  signals: SignalRepository;
}

@Module({})
export class SignalsModule {
  static register(config: SignalsModuleConfig): DynamicModule {
    return {
      module: SignalsModule,
      controllers: [SignalsController],
      providers: [
        { provide: SIGNALS_DB_CLIENT, useFactory: () => config.db },
        { provide: SIGNALS_REPO, useFactory: () => config.signals },
      ],
    };
  }
}
