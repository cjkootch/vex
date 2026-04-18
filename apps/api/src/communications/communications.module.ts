import { Module, type DynamicModule } from "@nestjs/common";
import type { ActivityRepository, Db, TouchpointRepository } from "@vex/db";
import {
  COMMUNICATIONS_ACTIVITY_REPO,
  COMMUNICATIONS_DB_CLIENT,
  COMMUNICATIONS_TOUCHPOINT_REPO,
  CommunicationsController,
} from "./communications.controller.js";

export interface CommunicationsModuleConfig {
  db: Db;
  touchpoints: TouchpointRepository;
  activities: ActivityRepository;
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
      ],
    };
  }
}
