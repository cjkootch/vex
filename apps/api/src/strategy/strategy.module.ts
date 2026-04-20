import { Module, type DynamicModule } from "@nestjs/common";
import type {
  Db,
  EventRepository,
  WorkspaceRepository,
} from "@vex/db";
import { StrategyController } from "./strategy.controller.js";
import { StrategyService } from "./strategy.service.js";
import {
  STRATEGY_DB_CLIENT,
  STRATEGY_EVENTS_REPO,
  STRATEGY_WORKSPACES_REPO,
} from "./tokens.js";

export interface StrategyModuleConfig {
  db: Db;
  workspaces: WorkspaceRepository;
  events: EventRepository;
}

@Module({})
export class StrategyModule {
  static register(config: StrategyModuleConfig): DynamicModule {
    return {
      module: StrategyModule,
      controllers: [StrategyController],
      providers: [
        { provide: STRATEGY_DB_CLIENT, useFactory: () => config.db },
        { provide: STRATEGY_WORKSPACES_REPO, useFactory: () => config.workspaces },
        { provide: STRATEGY_EVENTS_REPO, useFactory: () => config.events },
        StrategyService,
      ],
    };
  }
}
