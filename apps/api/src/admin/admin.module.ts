import { Module, type DynamicModule } from "@nestjs/common";
import type { Queue } from "bullmq";
import type { AgentJobData } from "@vex/agents";
import type {
  Db,
  EventRepository,
  OfacScreenRepository,
  OrganizationRepository,
  PortRepository,
  WorkspaceRepository,
} from "@vex/db";
import { AdminController } from "./admin.controller.js";
import { AdminService } from "./admin.service.js";
import {
  ADMIN_AGENTS_QUEUE,
  ADMIN_DB_CLIENT,
  ADMIN_EVAL_RESULTS_PATH,
  ADMIN_EVENTS_REPO,
  ADMIN_INTEGRATIONS_STATUS,
  ADMIN_OFAC_SCREENS_REPO,
  ADMIN_ORGANIZATIONS_REPO,
  ADMIN_PORTS_REPO,
  ADMIN_WORKSPACES_REPO,
} from "./tokens.js";

export interface IntegrationStatus {
  name: string;
  configured: boolean;
  required: boolean;
  notes?: string;
}

export interface AdminModuleConfig {
  db: Db;
  workspaces: WorkspaceRepository;
  events: EventRepository;
  /** Absolute path to `evals/results/latest.json`. */
  evalResultsPath: string;
  /**
   * Snapshot of every external integration at boot — presence +
   * required/optional flag + a short note for the admin UI. Computed
   * in main.ts from the loaded env so we don't re-read process.env
   * at request time.
   */
  integrations: IntegrationStatus[];
  ofacScreens: OfacScreenRepository;
  organizations: OrganizationRepository;
  ports: PortRepository;
  agentsQueue: Queue<AgentJobData>;
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
        {
          provide: ADMIN_INTEGRATIONS_STATUS,
          useFactory: () => config.integrations,
        },
        {
          provide: ADMIN_OFAC_SCREENS_REPO,
          useFactory: () => config.ofacScreens,
        },
        {
          provide: ADMIN_ORGANIZATIONS_REPO,
          useFactory: () => config.organizations,
        },
        {
          provide: ADMIN_AGENTS_QUEUE,
          useFactory: () => config.agentsQueue,
        },
        { provide: ADMIN_PORTS_REPO, useFactory: () => config.ports },
        AdminService,
      ],
    };
  }
}
