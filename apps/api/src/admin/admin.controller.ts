import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  NotFoundException,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from "@nestjs/common";
import type { Queue } from "bullmq";
import { addAgentJob, type AgentJobData } from "@vex/agents";
import { z } from "zod";
import { UserRole } from "@vex/domain";
import { desc, eq, inArray, sql } from "drizzle-orm";
import {
  schema,
  withTenant,
  type Db,
  type EventRepository,
  type OfacScreenRepository,
  type OrganizationRepository,
} from "@vex/db";
import { JwtAuthGuard, RequireRole, RolesGuard, TenantContext } from "../auth/index.js";
import { AdminService } from "./admin.service.js";
import {
  ADMIN_AGENTS_QUEUE,
  ADMIN_DB_CLIENT,
  ADMIN_EVENTS_REPO,
  ADMIN_INTEGRATIONS_STATUS,
  ADMIN_OFAC_SCREENS_REPO,
  ADMIN_ORGANIZATIONS_REPO,
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
    @Inject(ADMIN_OFAC_SCREENS_REPO)
    private readonly ofacScreens: OfacScreenRepository,
    @Inject(ADMIN_ORGANIZATIONS_REPO)
    private readonly organizations: OrganizationRepository,
    @Inject(ADMIN_AGENTS_QUEUE)
    private readonly agentsQueue: Queue<AgentJobData>,
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

  // ===========================================================================
  // OFAC screening
  // ===========================================================================

  /**
   * GET /admin/ofac/summary — count of orgs by ofac_status, the most
   * recent screen timestamp, and a small preview of potential matches.
   * Powers the admin OFAC tab's status bar.
   */
  @Get("ofac/summary")
  async getOfacSummary(): Promise<{
    counts: {
      unscreened: number;
      clear: number;
      potential_match: number;
      confirmed_match: number;
      cleared_by_operator: number;
    };
    lastScreenAt: string | null;
    totalOrgs: number;
  }> {
    return withTenant(this.db, this.tenant.tenantId, async (tx) => {
      const rows = await tx
        .select({
          status: schema.organizations.ofacStatus,
          count: sql<number>`count(*)::int`,
        })
        .from(schema.organizations)
        .where(eq(schema.organizations.status, "active"))
        .groupBy(schema.organizations.ofacStatus);

      const counts = {
        unscreened: 0,
        clear: 0,
        potential_match: 0,
        confirmed_match: 0,
        cleared_by_operator: 0,
      };
      let total = 0;
      for (const row of rows) {
        const c = Number(row.count);
        total += c;
        if (row.status in counts) {
          (counts as Record<string, number>)[row.status] = c;
        }
      }

      const [latest] = await tx
        .select({ screenedAt: schema.ofacScreens.screenedAt })
        .from(schema.ofacScreens)
        .orderBy(desc(schema.ofacScreens.screenedAt))
        .limit(1);

      return {
        counts,
        lastScreenAt: latest?.screenedAt.toISOString() ?? null,
        totalOrgs: total,
      };
    });
  }

  /**
   * GET /admin/ofac/screens?status=potential_match — list screens, one
   * row per org-screen, joined to org display name. Status filter is
   * optional; defaults to every "needs review" status.
   */
  @Get("ofac/screens")
  async listOfacScreens(
    @Query("status") statusRaw?: string,
  ): Promise<{
    screens: Array<{
      id: string;
      orgId: string;
      orgName: string | null;
      status: string;
      highestScore: number;
      matchCount: number;
      matches: unknown;
      screenedAt: string;
      clearedAt: string | null;
      clearedBy: string | null;
      clearedReason: string | null;
    }>;
  }> {
    const allowed = new Set([
      "clear",
      "potential_match",
      "confirmed_match",
      "cleared_by_operator",
    ]);
    const filters = statusRaw
      ? statusRaw.split(",").map((s) => s.trim()).filter((s) => allowed.has(s))
      : ["potential_match", "confirmed_match"];
    return withTenant(this.db, this.tenant.tenantId, async (tx) => {
      const rows = await tx
        .select({
          id: schema.ofacScreens.id,
          orgId: schema.ofacScreens.orgId,
          orgName: schema.organizations.legalName,
          status: schema.ofacScreens.status,
          highestScore: schema.ofacScreens.highestScore,
          matchCount: schema.ofacScreens.matchCount,
          matches: schema.ofacScreens.matches,
          screenedAt: schema.ofacScreens.screenedAt,
          clearedAt: schema.ofacScreens.clearedAt,
          clearedBy: schema.ofacScreens.clearedBy,
          clearedReason: schema.ofacScreens.clearedReason,
        })
        .from(schema.ofacScreens)
        .leftJoin(
          schema.organizations,
          eq(schema.ofacScreens.orgId, schema.organizations.id),
        )
        .where(
          filters.length > 0
            ? inArray(schema.ofacScreens.status, filters)
            : sql`true`,
        )
        .orderBy(desc(schema.ofacScreens.screenedAt))
        .limit(100);
      return {
        screens: rows.map((r) => ({
          id: r.id,
          orgId: r.orgId,
          orgName: r.orgName,
          status: r.status,
          highestScore: r.highestScore,
          matchCount: r.matchCount,
          matches: r.matches,
          screenedAt: r.screenedAt.toISOString(),
          clearedAt: r.clearedAt ? r.clearedAt.toISOString() : null,
          clearedBy: r.clearedBy,
          clearedReason: r.clearedReason,
        })),
      };
    });
  }

  /**
   * POST /admin/ofac/run — enqueue a batch screen of every active
   * organization in the workspace. Returns the jobId so the admin UI
   * can poll, though in practice the signals inbox is the primary
   * status surface.
   */
  @Post("ofac/run")
  @HttpCode(202)
  async runOfacScreen(): Promise<{ jobId: string; status: "queued" }> {
    const jobId = `manual:${Date.now()}`;
    await addAgentJob(
      this.agentsQueue,
      {
        kind: "ofac_screening",
        workspace_id: this.tenant.workspaceId,
      },
      jobId,
    );
    await withTenant(this.db, this.tenant.tenantId, async (tx) => {
      await this.events.insertIfNotExists(tx, this.tenant.tenantId, {
        verb: "ofac.screen_requested",
        subjectType: "workspace",
        subjectId: this.tenant.workspaceId,
        actorType: "user",
        actorId: this.tenant.userId,
        occurredAt: new Date(),
        idempotencyKey: `ofac.screen_requested:${jobId}`,
        metadata: { triggered_from: "admin_ui" },
      });
    });
    return { jobId, status: "queued" };
  }

  /**
   * PATCH /admin/ofac/clear — operator decision to downgrade a
   * potential_match to cleared_by_operator. Requires a reason; lands
   * both an audit row on ofac_screens (via the repo) and an event so
   * the compliance trail is reconstructable.
   */
  @Patch("ofac/clear/:screenId")
  async clearOfacScreen(
    @Param("screenId") screenId: string,
    @Body() raw: unknown,
  ): Promise<{ ok: true }> {
    const parsed = OfacClearBody.safeParse(raw);
    if (!parsed.success) throw new BadRequestException(parsed.error.message);
    await withTenant(this.db, this.tenant.tenantId, async (tx) => {
      const [row] = await tx
        .select({ id: schema.ofacScreens.id, orgId: schema.ofacScreens.orgId })
        .from(schema.ofacScreens)
        .where(eq(schema.ofacScreens.id, screenId))
        .limit(1);
      if (!row) throw new NotFoundException(`screen ${screenId} not found`);

      await this.ofacScreens.clearScreen(tx, {
        screenId,
        clearedBy: this.tenant.userId,
        reason: parsed.data.reason,
      });

      await this.events.insertIfNotExists(tx, this.tenant.tenantId, {
        verb: "ofac.match_cleared",
        subjectType: "organization",
        subjectId: row.orgId,
        actorType: "user",
        actorId: this.tenant.userId,
        objectType: "ofac_screen",
        objectId: screenId,
        occurredAt: new Date(),
        idempotencyKey: `ofac.match_cleared:${screenId}`,
        metadata: {
          reason: parsed.data.reason,
        },
      });
    });
    return { ok: true };
  }
}

const OfacClearBody = z.object({
  reason: z.string().min(1).max(1000),
});
