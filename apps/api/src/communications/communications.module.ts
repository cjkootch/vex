import { Module, type DynamicModule } from "@nestjs/common";
import type { Queue } from "bullmq";
import type {
  ActivityRepository,
  ApprovalRepository,
  Db,
  EventRepository,
  TouchpointRepository,
} from "@vex/db";
import type { ApprovalExecutorJobData } from "@vex/agents";
import {
  COMMUNICATIONS_ACTIVITY_REPO,
  COMMUNICATIONS_APPROVAL_EXECUTOR_QUEUE,
  COMMUNICATIONS_APPROVAL_REPO,
  COMMUNICATIONS_DB_CLIENT,
  COMMUNICATIONS_EVENT_REPO,
  COMMUNICATIONS_TOUCHPOINT_REPO,
  CommunicationsController,
} from "./communications.controller.js";

export interface CommunicationsModuleConfig {
  db: Db;
  touchpoints: TouchpointRepository;
  activities: ActivityRepository;
  approvals: ApprovalRepository;
  events: EventRepository;
  approvalExecutorQueue: Queue<ApprovalExecutorJobData>;
}

/**
 * Dynamic module for /communications — the unified inbox feed.
 * Thin wiring: the controller does all the work; this just injects
 * the two repos it needs.
 */
@Module({})
export class CommunicationsModule {
  static register(config: CommunicationsModuleConfig): DynamicModule {
    return {
      module: CommunicationsModule,
      controllers: [CommunicationsController],
      providers: [
        { provide: COMMUNICATIONS_DB_CLIENT, useFactory: () => config.db },
        {
          provide: COMMUNICATIONS_TOUCHPOINT_REPO,
          useFactory: () => config.touchpoints,
        },
        {
          provide: COMMUNICATIONS_ACTIVITY_REPO,
          useFactory: () => config.activities,
        },
        {
          provide: COMMUNICATIONS_APPROVAL_REPO,
          useFactory: () => config.approvals,
        },
        {
          provide: COMMUNICATIONS_EVENT_REPO,
          useFactory: () => config.events,
        },
        {
          provide: COMMUNICATIONS_APPROVAL_EXECUTOR_QUEUE,
          useFactory: () => config.approvalExecutorQueue,
        },
      ],
    };
  }
}
