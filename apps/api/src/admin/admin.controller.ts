import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Inject,
  Patch,
  Query,
  UseGuards,
} from "@nestjs/common";
import { z } from "zod";
import { UserRole } from "@vex/domain";
import {
  withTenant,
  type Db,
  type EventRepository,
} from "@vex/db";
import { JwtAuthGuard, RequireRole, RolesGuard, TenantContext } from "../auth/index.js";
import { AdminService } from "./admin.service.js";
import {
  ADMIN_DB_CLIENT,
  ADMIN_EVENTS_REPO,
  ADMIN_INTEGRATIONS_STATUS,
} from "./tokens.js";
import type { IntegrationStatus } from "./admin.module.js";

const SettingsPatchSchema = z
  .object({
    enabled_agents: z.array(z.string().min(1)).optional(),
    kill_all_agents: z.boolean().optional(),
    daily_cost_limit: z.number().min(0).max(10_000).optional(),
    source_priority: z.array(z.string().min(1)).optional(),
    feature_rollout: z.record(z.number().min(0).max(100)).optional(),
    sharing_enabled: z.boolean().optional(),
  })
  .strict();

/**
 * OWNER-only admin API. Every route is behind JwtAuthGuard +
 * RolesGuard + @RequireRole(OWNER). Cross-tenant writes are refused
 * inside the service for defense in depth.
 */
@Controller("admin")
@UseGuards(JwtAuthGuard, RolesGuard)
@RequireRole(UserRole.Owner)
export class AdminController {
  constructor(
    @Inject(TenantContext) private readonly tenant: TenantContext,
    @Inject(AdminService) private readonly service: AdminService,
    @Inject(ADMIN_DB_CLIENT) private readonly db: Db,
    @Inject(ADMIN_EVENTS_REPO) private readonly events: EventRepository,
    @Inject(ADMIN_INTEGRATIONS_STATUS)
    private readonly integrations: IntegrationStatus[],
  ) {}

  @Get("settings")
  async getSettings() {
    const settings = await this.service.getSettings(this.tenant.workspaceId);
    return { settings };
  }

  @Patch("settings")
  async updateSettings(@Body() raw: unknown) {
    const parsed = SettingsPatchSchema.safeParse(raw);
    if (!parsed.success) throw new BadRequestException(parsed.error.message);
    const settings = await this.service.updateSettings(
      this.tenant.tenantId,
      this.tenant.workspaceId,
      parsed.data,
      this.tenant.userId,
    );
    return { settings };
  }

  @Get("health")
  async getHealth() {
    return this.service.getHealthMetrics(this.tenant.tenantId);
  }

  @Get("cost-ledger")
  async getCostLedger(
    @Query("from") from?: string,
    @Query("to") to?: string,
    @Query("limit") limit?: string,
  ) {
    const parsedLimit = limit ? Number.parseInt(limit, 10) : undefined;
    return this.service.getCostLedger(
      this.tenant.tenantId,
      from,
      to,
      Number.isFinite(parsedLimit) && parsedLimit! > 0 ? parsedLimit : undefined,
    );
  }

  @Get("evals/latest")
  async getLatestEvals() {
    const results = await this.service.getLatestEvalResults();
    if (!results) {
      return { status: "no_results", message: "No eval run results available yet." };
    }
    return { status: "ok", results };
  }

  /**
   * Snapshot of every external integration's configuration status.
   * Computed at boot from the loaded env, returned verbatim. The UI
   * shows green/red pills per row; red on a `required` integration
   * is a hard operational issue.
   */
  @Get("integrations")
  async getIntegrations(): Promise<{ integrations: IntegrationStatus[] }> {
    return { integrations: this.integrations };
  }

  /**
   * Capability-gap feed — rows where the chat agent emitted
   * `unsupported_request` because no existing action could fulfil
   * the user's command. Operators review these to prioritise new
   * action types. Newest-first, keyset-paginated by `before`.
   */
  @Get("feature-requests")
  async getFeatureRequests(
    @Query("before") before?: string,
    @Query("limit") limitRaw?: string,
  ): Promise<{
    items: Array<{
      id: string;
      occurredAt: string;
      actorId: string | null;
      originalCommand: string;
      reason: string;
      suggestion: string | null;
    }>;
    nextBefore: string | null;
  }> {
    const limit = Math.min(Number.parseInt(limitRaw ?? "50", 10) || 50, 200);
    const beforeDate = before ? new Date(before) : undefined;
    const rows = await withTenant(this.db, this.tenant.tenantId, async (tx) =>
      this.events.listByVerb(
        tx,
        "chat.unsupported_request",
        limit,
        beforeDate && !Number.isNaN(beforeDate.getTime())
          ? beforeDate
          : undefined,
      ),
    );
    const items = rows.map((r) => {
      const meta = (r.metadata ?? {}) as Record<string, unknown>;
      return {
        id: r.id,
        occurredAt: r.occurredAt.toISOString(),
        actorId: r.actorId,
        originalCommand:
          typeof meta["original_command"] === "string"
            ? (meta["original_command"] as string)
            : "",
        reason:
          typeof meta["reason"] === "string"
            ? (meta["reason"] as string)
            : "",
        suggestion:
          typeof meta["suggestion"] === "string"
            ? (meta["suggestion"] as string)
            : null,
      };
    });
    return {
      items,
      nextBefore:
        items.length === limit && items[items.length - 1]
          ? items[items.length - 1]!.occurredAt
          : null,
    };
  }
}
