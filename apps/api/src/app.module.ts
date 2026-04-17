import { Module, type DynamicModule } from "@nestjs/common";
import { APP_GUARD } from "@nestjs/core";
import { ThrottlerModule } from "@nestjs/throttler";
import { AuthModule } from "./auth/index.js";
import { HealthModule } from "./health/health.module.js";
import { OrganizationsController } from "./organizations/organizations.controller.js";
import { WebhooksModule } from "./webhooks/webhooks.module.js";
import { QueryModule } from "./query/query.module.js";
import { ApprovalsModule } from "./approvals/approvals.module.js";
import { AgentRunsModule } from "./agent-runs/agent-runs.module.js";
import { VoiceModule } from "./voice/voice.module.js";
import { TenantThrottlerGuard } from "./throttler/tenant-throttler.guard.js";

export interface AppModuleConfig {
  webhooks: DynamicModule;
  query?: DynamicModule;
  approvals?: DynamicModule;
  agentRuns?: DynamicModule;
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
    if (config.voice) imports.push(config.voice);
    if (config.health) imports.push(config.health);
    return {
      module: AppModule,
      imports,
      controllers: [OrganizationsController],
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
  VoiceModule,
  HealthModule,
};
