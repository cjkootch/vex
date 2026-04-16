import { Module, type DynamicModule } from "@nestjs/common";
import type { Db, RetrievalService } from "@vex/db";
import type { AnthropicAdapter, OpenAIAdapter } from "@vex/integrations";
import { QueryController } from "./query.controller.js";
import { QueryService } from "./query.service.js";
import {
  ANTHROPIC_ADAPTER,
  DB_CLIENT,
  OPENAI_ADAPTER,
  RETRIEVAL_SERVICE,
} from "./tokens.js";

export interface QueryModuleConfig {
  db: Db;
  retrieval: RetrievalService;
  openai: OpenAIAdapter;
  anthropic: AnthropicAdapter;
}

@Module({})
export class QueryModule {
  static register(config: QueryModuleConfig): DynamicModule {
    return {
      module: QueryModule,
      controllers: [QueryController],
      providers: [
        { provide: DB_CLIENT, useValue: config.db },
        { provide: RETRIEVAL_SERVICE, useValue: config.retrieval },
        { provide: OPENAI_ADAPTER, useValue: config.openai },
        { provide: ANTHROPIC_ADAPTER, useValue: config.anthropic },
        QueryService,
      ],
    };
  }
}
