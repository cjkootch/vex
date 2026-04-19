import { Module, type DynamicModule } from "@nestjs/common";
import type { Db, RetrievalService } from "@vex/db";
import type {
  AnthropicAdapter,
  OpenAIAdapter,
  TavilyClient,
} from "@vex/integrations";
import { QueryController } from "./query.controller.js";
import { QueryService } from "./query.service.js";
import {
  ANTHROPIC_ADAPTER,
  DB_CLIENT,
  OPENAI_ADAPTER,
  RETRIEVAL_SERVICE,
  TAVILY_CLIENT,
} from "./tokens.js";

export interface QueryModuleConfig {
  db: Db;
  retrieval: RetrievalService;
  openai: OpenAIAdapter;
  anthropic: AnthropicAdapter;
  /** Null when TAVILY_API_KEY isn't configured — research_contact tool disables. */
  tavily: TavilyClient | null;
}

@Module({})
export class QueryModule {
  static register(config: QueryModuleConfig): DynamicModule {
    return {
      module: QueryModule,
      controllers: [QueryController],
      providers: [
        { provide: DB_CLIENT, useFactory: () => config.db },
        { provide: RETRIEVAL_SERVICE, useFactory: () => config.retrieval },
        { provide: OPENAI_ADAPTER, useFactory: () => config.openai },
        { provide: ANTHROPIC_ADAPTER, useFactory: () => config.anthropic },
        { provide: TAVILY_CLIENT, useFactory: () => config.tavily },
        QueryService,
      ],
    };
  }
}
