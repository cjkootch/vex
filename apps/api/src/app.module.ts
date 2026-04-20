import { Module, type DynamicModule } from "@nestjs/common";
import { APP_GUARD } from "@nestjs/core";
import { ThrottlerModule } from "@nestjs/throttler";
import { AuthModule } from "./auth/index.js";
import { HealthModule } from "./health/health.module.js";
import { OrganizationsModule } from "./organizations/organizations.module.js";
import { WebhooksModule } from "./webhooks/webhooks.module.js";
import { QueryModule } from "./query/query.module.js";
import { ApprovalsModule } from "./approvals/approvals.module.js";
import { AgentRunsModule } from "./agent-runs/agent-runs.module.js";
import { AdminModule } from "./admin/admin.module.js";
import { BriefModule } from "./brief/brief.module.js";
import { CallsModule } from "./calls/calls.module.js";
import { CommunicationsModule } from "./communications/communications.module.js";
import { FollowUpsModule } from "./follow-ups/follow-ups.module.js";
import { ContactsModule } from "./contacts/contacts.module.js";
import { DealsModule } from "./deals/deals.module.js";
import { EventsModule } from "./events/events.module.js";
import { MarketingModule } from "./marketing/marketing.module.js";
import { SearchModule } from "./search/search.module.js";
import { StrategyModule } from "./strategy/strategy.module.js";
import { VoiceModule } from "./voice/voice.module.js";
import { TenantThrottlerGuard } from "./throttler/tenant-throttler.guard.js";

export interface AppModuleConfig {
  webhooks: DynamicModule;
  query?: DynamicModule;
  approvals?: DynamicModule;
  agentRuns?: DynamicModule;
  brief?: DynamicModule;
  calls?: DynamicModule;
  communications?: DynamicModule;
  followUps?: DynamicModule;
  documents?: DynamicModule;
  signals?: DynamicModule;
  contacts?: DynamicModule;
  deals?: DynamicModule;
  events?: DynamicModule;
  marketing?: DynamicModule;
  organizations?: DynamicModule;
  search?: DynamicModule;
  admin?: DynamicModule;
  strategy?: DynamicModule;
  voice?: DynamicModule;
  health?: DynamicModule;
  nextAuthSecret: string;
}

/**
 * Global rate limits. Per-route overrides live next to the controller:
 *
 *   - `default`: 100 requests/minute per tenant across unreserved routes.
 *   - `query`:    10 requests/minute per tenant for LLM-heavy endpoints.
 *   - `webhooks`: 500 requests/minute per IP — webhook senders are
 *                 bursty and not tenant-scoped; the WebhooksModule uses
 *                 `@SkipThrottle()` + its own per-provider guards.
 *
 * All limits are in-memory (default ThrottlerStorage). Multi-node
 * deployments should swap in `@nestjs/throttler-storage-redis`; the
 * guard key contract stays the same.
 */
const THROTTLER_NAMES = {
  default: "default",
  query: "query",
  webhooks: "webhooks",
} as const;

@Module({})
export class AppModule {
  static register(config: AppModuleConfig): DynamicModule {
    const imports: DynamicModule[] = [
      ThrottlerModule.forRoot([
        { name: THROTTLER_NAMES.default, ttl: 60_000, limit: 100 },
        { name: THROTTLER_NAMES.query, ttl: 60_000, limit: 10 },
        { name: THROTTLER_NAMES.webhooks, ttl: 60_000, limit: 500 },
      ]),
      AuthModule.register({ nextAuthSecret: config.nextAuthSecret }),
      config.webhooks,
    ];
    if (config.query) imports.push(config.query);
    if (config.approvals) imports.push(config.approvals);
    if (config.agentRuns) imports.push(config.agentRuns);
    if (config.brief) imports.push(config.brief);
    if (config.communications) imports.push(config.communications);
    if (config.followUps) imports.push(config.followUps);
    if (config.documents) imports.push(config.documents);
    if (config.signals) imports.push(config.signals);
    if (config.contacts) imports.push(config.contacts);
    if (config.deals) imports.push(config.deals);
    if (config.events) imports.push(config.events);
    if (config.marketing) imports.push(config.marketing);
    if (config.organizations) imports.push(config.organizations);
    if (config.search) imports.push(config.search);
    if (config.calls) imports.push(config.calls);
    if (config.admin) imports.push(config.admin);
    if (config.strategy) imports.push(config.strategy);
    if (config.voice) imports.push(config.voice);
    if (config.health) imports.push(config.health);
    return {
      module: AppModule,
      imports,
      controllers: [],
      providers: [
        { provide: APP_GUARD, useClass: TenantThrottlerGuard },
      ],
    };
  }
}

export {
  WebhooksModule,
  QueryModule,
  ApprovalsModule,
  AgentRunsModule,
  AdminModule,
  BriefModule,
  CallsModule,
  CommunicationsModule,
  FollowUpsModule,
  ContactsModule,
  DealsModule,
  EventsModule,
  MarketingModule,
  OrganizationsModule,
  SearchModule,
  StrategyModule,
  VoiceModule,
  HealthModule,
};
