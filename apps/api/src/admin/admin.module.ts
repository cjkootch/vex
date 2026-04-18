import { Module, type DynamicModule } from "@nestjs/common";
import type {
  Db,
  EventRepository,
  WorkspaceRepository,
} from "@vex/db";
import { AdminController } from "./admin.controller.js";
import { AdminService } from "./admin.service.js";
import {
  ADMIN_DB_CLIENT,
  ADMIN_EVAL_RESULTS_PATH,
  ADMIN_EVENTS_REPO,
  ADMIN_WORKSPACES_REPO,
} from "./tokens.js";

export interface AdminModuleConfig {
  db: Db;
  workspaces: WorkspaceRepository;
  events: EventRepository;
  /** Absolute path to `evals/results/latest.json`. */
  evalResultsPath: string;
}

@Module({})
export class AdminModule {
  static register(config: AdminModuleConfig): DynamicModule {
    return {
      module: AdminModule,
      controllers: [AdminController],
      providers: [
        { provide: ADMIN_DB_CLIENT, useFactory: () => config.db },
        { provide: ADMIN_WORKSPACES_REPO, useFactory: () => config.workspaces },
        { provide: ADMIN_EVENTS_REPO, useFactory: () => config.events },
        { provide: ADMIN_EVAL_RESULTS_PATH, useFactory: () => config.evalResultsPath },
        AdminService,
      ],
    };
  }
}
