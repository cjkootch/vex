import { Module, type DynamicModule } from "@nestjs/common";
import type {
  Db,
  EventRepository,
  FuelDealRepository,
  WorkspaceRepository,
} from "@vex/db";
import type { AnthropicAdapter } from "@vex/integrations";
import { StrategyController } from "./strategy.controller.js";
import { StrategyService } from "./strategy.service.js";
import {
  STRATEGY_ANTHROPIC,
  STRATEGY_DB_CLIENT,
  STRATEGY_DEALS_REPO,
  STRATEGY_EVENTS_REPO,
  STRATEGY_WORKSPACES_REPO,
} from "./tokens.js";

export interface StrategyModuleConfig {
  db: Db;
  workspaces: WorkspaceRepository;
  events: EventRepository;
  deals: FuelDealRepository;
  anthropic: AnthropicAdapter;
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
        { provide: STRATEGY_DEALS_REPO, useFactory: () => config.deals },
        { provide: STRATEGY_ANTHROPIC, useFactory: () => config.anthropic },
        StrategyService,
      ],
    };
  }
}
