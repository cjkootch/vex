import { Module, type DynamicModule } from "@nestjs/common";
import type { ApprovalRepository, Db, SummaryRepository } from "@vex/db";
import {
  BRIEF_APPROVAL_REPO,
  BRIEF_DB_CLIENT,
  BRIEF_SUMMARY_REPO,
  BriefController,
} from "./brief.controller.js";

export interface BriefModuleConfig {
  db: Db;
  summaries: SummaryRepository;
  approvals: ApprovalRepository;
}

/**
 * Dynamic module for the /brief read endpoints. Wires the DB client and
 * the two repositories the controller uses. Registered optionally from
 * AppModule so tests can omit it.
 */
@Module({})
export class BriefModule {
  static register(config: BriefModuleConfig): DynamicModule {
    return {
      module: BriefModule,
      controllers: [BriefController],
      providers: [
        { provide: BRIEF_DB_CLIENT, useFactory: () => config.db },
        { provide: BRIEF_SUMMARY_REPO, useFactory: () => config.summaries },
        { provide: BRIEF_APPROVAL_REPO, useFactory: () => config.approvals },
      ],
    };
  }
}
