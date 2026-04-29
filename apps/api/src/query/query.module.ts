import { Module, type DynamicModule } from "@nestjs/common";
import type { Queue } from "bullmq";
import type { ApprovalExecutorJobData } from "@vex/agents";
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
  APPROVAL_EXECUTOR_QUEUE,
  COST_LEDGER,
  DB_CLIENT,
  DEFAULT_WORKSPACE_ID,
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
  /**
   * Approval-executor queue. Chat-emitted T1 actions get an
   * auto-approved approval row + an enqueued executor job so they
   * apply through the same worker path operator approvals use.
   */
  approvalExecutorQueue: Queue<ApprovalExecutorJobData>;
  /** Workspace id for chat-issued approvals. */
  defaultWorkspaceId: string;
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
        {
          provide: APPROVAL_EXECUTOR_QUEUE,
          useFactory: () => config.approvalExecutorQueue,
        },
        {
          provide: DEFAULT_WORKSPACE_ID,
          useFactory: () => config.defaultWorkspaceId,
        },
        QueryService,
      ],
    };
  }
}
