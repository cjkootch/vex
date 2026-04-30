import { Module, type DynamicModule } from "@nestjs/common";
import type { Queue } from "bullmq";
import type { AgentJobData } from "@vex/agents";
import type {
  ContactOrgMembershipRepository,
  ContactRepository,
  Db,
  EventRepository,
  LeadRepository,
  OrganizationRepository,
} from "@vex/db";
import { IngestController } from "./ingest.controller.js";
import { IngestService } from "./ingest.service.js";
import {
  INGEST_AGENTS_QUEUE,
  INGEST_CONTACTS_REPO,
  INGEST_DB_CLIENT,
  INGEST_DEFAULT_TENANT_ID,
  INGEST_EVENTS_REPO,
  INGEST_LEADS_REPO,
  INGEST_MEMBERSHIPS_REPO,
  INGEST_ORGANIZATIONS_REPO,
  INGEST_WEB_APP_BASE_URL,
} from "./tokens.js";

export interface IngestModuleConfig {
  db: Db;
  organizations: OrganizationRepository;
  contacts: ContactRepository;
  memberships: ContactOrgMembershipRepository;
  leads: LeadRepository;
  events: EventRepository;
  agentsQueue: Queue<AgentJobData>;
  /**
   * Tenant/workspace id every ingest write attributes to. Single-tenant
   * for now (the procur integration is one shared pipe); becomes a
   * lookup once vex hosts multiple workspaces against the same procur
   * deployment.
   */
  defaultTenantId: string;
  /** Web-app base URL for the deep-link in the response. Null = omit. */
  webAppBaseUrl: string | null;
}

@Module({})
export class IngestModule {
  static register(config: IngestModuleConfig): DynamicModule {
    return {
      module: IngestModule,
      controllers: [IngestController],
      providers: [
        { provide: INGEST_DB_CLIENT, useFactory: () => config.db },
        {
          provide: INGEST_ORGANIZATIONS_REPO,
          useFactory: () => config.organizations,
        },
        { provide: INGEST_CONTACTS_REPO, useFactory: () => config.contacts },
        {
          provide: INGEST_MEMBERSHIPS_REPO,
          useFactory: () => config.memberships,
        },
        { provide: INGEST_LEADS_REPO, useFactory: () => config.leads },
        { provide: INGEST_EVENTS_REPO, useFactory: () => config.events },
        { provide: INGEST_AGENTS_QUEUE, useFactory: () => config.agentsQueue },
        {
          provide: INGEST_DEFAULT_TENANT_ID,
          useFactory: () => config.defaultTenantId,
        },
        {
          provide: INGEST_WEB_APP_BASE_URL,
          useFactory: () => config.webAppBaseUrl,
        },
        IngestService,
      ],
    };
  }
}
