import { Module, type DynamicModule } from "@nestjs/common";
import type { Queue } from "bullmq";
import type { ApprovalRepository, Db, EventRepository } from "@vex/db";
import type { ApprovalExecutorJobData } from "@vex/agents";
import type { Client as TemporalClient } from "@temporalio/client";
import { ApprovalsController } from "./approvals.controller.js";
import { ApprovalsService } from "./approvals.service.js";
import {
  APPROVAL_EXECUTOR_QUEUE,
  APPROVALS_DB_CLIENT,
  APPROVALS_EVENTS_REPO,
  APPROVALS_REPO,
  TEMPORAL_CLIENT,
} from "./tokens.js";

export interface ApprovalsModuleConfig {
  db: Db;
  approvals: ApprovalRepository;
  events: EventRepository;
  executorQueue: Queue<ApprovalExecutorJobData>;
  /** Optional — when null, signal sending is a no-op. Useful in tests. */
  temporal: TemporalClient | null;
}

@Module({})
export class ApprovalsModule {
  static register(config: ApprovalsModuleConfig): DynamicModule {
    return {
      module: ApprovalsModule,
      controllers: [ApprovalsController],
      providers: [
        { provide: APPROVALS_DB_CLIENT, useFactory: () => config.db },
        { provide: APPROVALS_REPO, useFactory: () => config.approvals },
        { provide: APPROVALS_EVENTS_REPO, useFactory: () => config.events },
        { provide: APPROVAL_EXECUTOR_QUEUE, useFactory: () => config.executorQueue },
        { provide: TEMPORAL_CLIENT, useFactory: () => config.temporal },
        ApprovalsService,
      ],
    };
  }
}
