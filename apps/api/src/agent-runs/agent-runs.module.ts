import { Module, type DynamicModule } from "@nestjs/common";
import type { AgentRunRepository, ApprovalRepository, Db } from "@vex/db";
import {
  AGENT_RUNS_APPROVAL_REPO,
  AGENT_RUNS_DB_CLIENT,
  AGENT_RUNS_REPO,
  AgentRunsController,
} from "./agent-runs.controller.js";

export interface AgentRunsModuleConfig {
  db: Db;
  agentRuns: AgentRunRepository;
  approvals: ApprovalRepository;
}

/**
 * Dynamic module for the /agent-runs read endpoint. Wires the DB client
 * and the two repositories the controller depends on. Registered
 * optionally from AppModule so tests can omit it.
 */
@Module({})
export class AgentRunsModule {
  static register(config: AgentRunsModuleConfig): DynamicModule {
    return {
      module: AgentRunsModule,
      controllers: [AgentRunsController],
      providers: [
        { provide: AGENT_RUNS_DB_CLIENT, useValue: config.db },
        { provide: AGENT_RUNS_REPO, useValue: config.agentRuns },
        { provide: AGENT_RUNS_APPROVAL_REPO, useValue: config.approvals },
      ],
    };
  }
}
