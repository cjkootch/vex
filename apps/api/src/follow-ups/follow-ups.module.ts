import { Module, type DynamicModule } from "@nestjs/common";
import type { Db, FollowUpRepository } from "@vex/db";
import {
  FOLLOW_UPS_DB_CLIENT,
  FOLLOW_UPS_REPO,
  FollowUpsController,
} from "./follow-ups.controller.js";

export interface FollowUpsModuleConfig {
  db: Db;
  followUps: FollowUpRepository;
}

@Module({})
export class FollowUpsModule {
  static register(config: FollowUpsModuleConfig): DynamicModule {
    return {
      module: FollowUpsModule,
      controllers: [FollowUpsController],
      providers: [
        { provide: FOLLOW_UPS_DB_CLIENT, useFactory: () => config.db },
        { provide: FOLLOW_UPS_REPO, useFactory: () => config.followUps },
      ],
    };
  }
}
