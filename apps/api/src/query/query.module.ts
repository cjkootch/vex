import { Module, type DynamicModule } from "@nestjs/common";
import type { Db, RetrievalService } from "@vex/db";
import type {
  AnthropicAdapter,
  OpenAIAdapter,
  TavilyClient,
} from "@vex/integrations";
import type { CostLedger } from "@vex/telemetry";
import { QueryController } from "./query.controller.js";
import { QueryService } from "./query.service.js";
import {
  ANTHROPIC_ADAPTER,
  COST_LEDGER,
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
  /**
   * Shared CostLedger so Tavily (web.search) spend lands in the
   * Admin Cost tab alongside Anthropic/OpenAI. The LLM adapters
   * record their own tokens via the adapters themselves; this
   * wires the tool-runner path.
   */
  costLedger: CostLedger;
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
        { provide: COST_LEDGER, useFactory: () => config.costLedger },
        QueryService,
      ],
    };
  }
}
