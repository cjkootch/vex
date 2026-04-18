import { Module, type DynamicModule } from "@nestjs/common";
import type { Redis } from "ioredis";
import type { Client as TemporalClient } from "@temporalio/client";
import type { Db } from "@vex/db";
import type { QueueHandles } from "@vex/agents";
import { HealthController } from "./health.controller.js";
import { HealthService } from "./health.service.js";
import {
  HEALTH_DB,
  HEALTH_QUEUES,
  HEALTH_REDIS,
  HEALTH_TEMPORAL,
} from "./tokens.js";

export interface HealthModuleConfig {
  db: Db;
  redis: Redis;
  temporal: TemporalClient | null;
  queues: QueueHandles | null;
}

@Module({})
export class HealthModule {
  static register(config: HealthModuleConfig): DynamicModule {
    return {
      module: HealthModule,
      controllers: [HealthController],
      providers: [
        { provide: HEALTH_DB, useFactory: () => config.db },
        { provide: HEALTH_REDIS, useFactory: () => config.redis },
        { provide: HEALTH_TEMPORAL, useFactory: () => config.temporal },
        { provide: HEALTH_QUEUES, useFactory: () => config.queues },
        HealthService,
      ],
    };
  }
}
