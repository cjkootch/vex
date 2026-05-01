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
  type Port,
  type PortEvent,
  type PortRepository,
} from "@vex/db";
import type { ProcurClient } from "@vex/integrations";
import { JwtAuthGuard, RequireRole, RolesGuard, TenantContext } from "../auth/index.js";
import { AdminService } from "./admin.service.js";
import {
  ADMIN_AGENTS_QUEUE,
  ADMIN_DB_CLIENT,
  ADMIN_EVENTS_REPO,
  ADMIN_INTEGRATIONS_STATUS,
  ADMIN_OFAC_SCREENS_REPO,
  ADMIN_ORGANIZATIONS_REPO,
  ADMIN_PORTS_REPO,
  ADMIN_PROCUR_CLIENT,
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
    email_signature: z
      .object({
        html: z.string().max(4000).optional(),
        text: z.string().max(2000).optional(),
      })
      .strict()
      .optional(),
    email_from_name: z.string().max(120).optional(),
    email_cc: z.array(z.string().email()).max(5).optional(),
    enabled_sanctions_lists: z
      .array(z.enum(["us_csl", "eu", "uk_ofsi"]))
      .max(3)
      .optional(),
    whatsapp_templates: z
      .array(
        z
          .object({
            name: z
              .string()
              .min(1)
              .max(120)
              .regex(/^[a-z0-9_]+$/, "name must be lowercase + snake_case"),
            contentSid: z
              .string()
              .regex(/^HX[a-fA-F0-9]{32}$/, "contentSid must be HX + 32 hex chars"),
            description: z.string().max(500).optional(),
            variables: z.array(z.string().min(1).max(60)).max(20).optional(),
          })
          .strict(),
      )
      .max(50)
      .optional(),
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
    @Inject(ADMIN_PORTS_REPO)
    private readonly portsRepo: PortRepository,
    @Inject(ADMIN_PROCUR_CLIENT)
    private readonly procur: ProcurClient,
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
   * Procur HTTP API healthcheck — runs a small battery of read-only
   * calls against procur's `/intelligence/*` endpoints and returns
   * each result verbatim. Useful for confirming env wiring,
   * authentication, and what shape of data procur is returning at
   * the moment.
   *
   * Query params (all optional):
   *   ?supplier=<name>        — name to feed to analyzeSupplier
   *   ?country=<ISO-2>        — country for findRecentCargoes
   *   ?days=<number>          — lookback days for findRecentCargoes
   *
   * Failure semantics: every probe is surfaced as a `{ ok, ... }`
   * object — no method ever throws past the controller. If procur
   * is `disabled` (env unset) you'll get `disabled` rows for each
   * probe; if procur is up but returning errors you'll see the
   * specific `reason` per call.
   */
  @Get("procur/healthcheck")
  async procurHealthcheck(
    @Query("supplier") supplier?: string,
    @Query("country") country?: string,
    @Query("days") daysRaw?: string,
  ): Promise<{
    isEnabled: boolean;
    probes: Array<{
      method: string;
      args: Record<string, unknown>;
      result: unknown;
    }>;
  }> {
    const supplierName = supplier?.trim() || "Refidomsa";
    const buyerCountry = country?.trim()?.toUpperCase() || "DO";
    const daysLookback = Number.parseInt(daysRaw ?? "30", 10) || 30;

    const probes = await Promise.all([
      (async () => ({
        method: "analyzeSupplier",
        args: { supplierName },
        result: await this.procur.analyzeSupplier({ supplierName }),
      }))(),
      (async () => ({
        method: "findRecentCargoes",
        args: { destinationCountry: buyerCountry, daysLookback },
        result: await this.procur.findRecentCargoes({
          destinationCountry: buyerCountry,
          daysLookback,
        }),
      }))(),
      (async () => ({
        method: "findDistressedSuppliers",
        args: { countries: [buyerCountry] },
        result: await this.procur.findDistressedSuppliers({
          countries: [buyerCountry],
        }),
      }))(),
      (async () => ({
        method: "evaluateOffer",
        args: {
          categoryTag: "diesel",
          buyerCountry,
          offeredPriceUsd: 0.85,
          offeredPriceUnit: "USD/L",
        },
        result: await this.procur.evaluateOffer({
          categoryTag: "diesel",
          buyerCountry,
          offeredPriceUsd: 0.85,
          offeredPriceUnit: "USD/L",
        }),
      }))(),
    ]);

    return {
      isEnabled: this.procur.isEnabled(),
      probes,
    };
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

  // ===========================================================================
  // Ports admin (0020_ports — T7)
  // ===========================================================================

  /**
   * GET /admin/ports — every port in the tenant, alphabetical. Feeds
   * the Admin → Ports tab table.
   */
  @Get("ports")
  async listPorts(): Promise<{ ports: Port[] }> {
    const rows = await withTenant(this.db, this.tenant.tenantId, async (tx) =>
      this.portsRepo.listAll(tx),
    );
    return { ports: rows };
  }

  /**
   * POST /admin/ports — create a new port. Idempotent by
   * (tenant, unlocode) — a duplicate throws a clean BadRequest so
   * the UI can surface "already exists" without a 500.
   */
  @Post("ports")
  @HttpCode(201)
  async createPort(@Body() raw: unknown): Promise<{ port: Port }> {
    const parsed = CreatePortBody.safeParse(raw);
    if (!parsed.success) throw new BadRequestException(parsed.error.message);
    const input = parsed.data;
    // Normalise: Zod's nullable().optional() yields T | null | undefined
    // but PortCreate wants T | null. Convert undefined → null across
    // the nullable fields so the repo's explicit shape checks pass.
    const create = {
      unlocode: input.unlocode,
      name: input.name,
      countryCode: input.countryCode,
      region: input.region,
      lat: input.lat ?? null,
      lng: input.lng ?? null,
      maxDraftM: input.maxDraftM ?? null,
      maxLoaM: input.maxLoaM ?? null,
      maxBeamM: input.maxBeamM ?? null,
      maxDwtMt: input.maxDwtMt ?? null,
      customsClearanceDaysMedian: input.customsClearanceDaysMedian ?? null,
      portDaysMedian: input.portDaysMedian ?? null,
      tariffNotes: input.tariffNotes ?? null,
      restrictedCargoNotes: input.restrictedCargoNotes ?? null,
      workingHours: input.workingHours ?? null,
      localAgentOrgId: input.localAgentOrgId ?? null,
      ...(input.fuelTerminal !== undefined
        ? { fuelTerminal: input.fuelTerminal }
        : {}),
      ...(input.containerTerminal !== undefined
        ? { containerTerminal: input.containerTerminal }
        : {}),
      ...(input.bulkTerminal !== undefined
        ? { bulkTerminal: input.bulkTerminal }
        : {}),
      ...(input.reeferCapable !== undefined
        ? { reeferCapable: input.reeferCapable }
        : {}),
      ...(input.congestionFactor !== undefined
        ? { congestionFactor: input.congestionFactor }
        : {}),
      ...(input.pilotageRequired !== undefined
        ? { pilotageRequired: input.pilotageRequired }
        : {}),
    };
    const port = await withTenant(
      this.db,
      this.tenant.tenantId,
      async (tx) => {
        const existing = await this.portsRepo.findByUnlocode(tx, input.unlocode);
        if (existing) {
          throw new BadRequestException(
            `port with UNLOCODE ${input.unlocode} already exists`,
          );
        }
        return this.portsRepo.create(tx, this.tenant.tenantId, create);
      },
    );
    return { port };
  }

  @Get("ports/:id")
  async getPort(@Param("id") id: string): Promise<{
    port: Port;
    events: PortEvent[];
  }> {
    return withTenant(this.db, this.tenant.tenantId, async (tx) => {
      const port = await this.portsRepo.findById(tx, id);
      if (!port) throw new NotFoundException(`port ${id} not found`);
      const events = await this.portsRepo.listActiveEvents(tx, id);
      return { port, events };
    });
  }

  @Patch("ports/:id")
  async updatePort(
    @Param("id") id: string,
    @Body() raw: unknown,
  ): Promise<{ port: Port }> {
    const parsed = UpdatePortBody.safeParse(raw);
    if (!parsed.success) throw new BadRequestException(parsed.error.message);
    // Strip undefineds so PortRepository.update doesn't overwrite
    // untouched columns. lastVerifiedAt is bumped when the payload
    // includes it or the caller explicitly opts in via verify=true.
    const patchRaw = parsed.data;
    const patch: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(patchRaw)) {
      if (k === "verify") continue;
      if (v !== undefined) patch[k] = v;
    }
    if (patchRaw.verify === true) {
      patch["lastVerifiedAt"] = new Date();
    }
    const port = await withTenant(
      this.db,
      this.tenant.tenantId,
      async (tx) => this.portsRepo.update(tx, id, patch),
    );
    return { port };
  }

  @Get("port-events")
  async listPortEvents(
    @Query("active") activeRaw?: string,
  ): Promise<{ events: PortEvent[] }> {
    const activeOnly = activeRaw !== "false";
    const events = await withTenant(
      this.db,
      this.tenant.tenantId,
      async (tx) =>
        activeOnly
          ? this.portsRepo.listActiveEvents(tx)
          : this.portsRepo.listActiveEvents(tx), // only active for now; extend later
    );
    return { events };
  }

  @Post("port-events")
  @HttpCode(201)
  async createPortEvent(
    @Body() raw: unknown,
  ): Promise<{ event: PortEvent }> {
    const parsed = CreatePortEventBody.safeParse(raw);
    if (!parsed.success) throw new BadRequestException(parsed.error.message);
    const input = parsed.data;
    const event = await withTenant(
      this.db,
      this.tenant.tenantId,
      async (tx) => {
        const port = await this.portsRepo.findById(tx, input.portId);
        if (!port)
          throw new NotFoundException(`port ${input.portId} not found`);
        return this.portsRepo.insertEvent(tx, this.tenant.tenantId, {
          portId: input.portId,
          eventType: input.eventType,
          severity: input.severity ?? "info",
          startsAt: new Date(input.startsAt),
          endsAt: input.endsAt ? new Date(input.endsAt) : null,
          title: input.title,
          body: input.body ?? null,
          sourceUrl: input.sourceUrl ?? null,
        });
      },
    );
    return { event };
  }
}

const OfacClearBody = z.object({
  reason: z.string().min(1).max(1000),
});

// ---------------------------------------------------------------------------
// Ports admin — Zod bodies
// ---------------------------------------------------------------------------

const UNLOCODE_RE = /^[A-Z]{2}[A-Z0-9]{3}$/;

const PortCommonFields = {
  name: z.string().min(1).max(200),
  countryCode: z.string().length(2).toUpperCase(),
  region: z.string().min(1).max(60),
  lat: z.number().min(-90).max(90).nullable().optional(),
  lng: z.number().min(-180).max(180).nullable().optional(),
  maxDraftM: z.number().positive().nullable().optional(),
  maxLoaM: z.number().positive().nullable().optional(),
  maxBeamM: z.number().positive().nullable().optional(),
  maxDwtMt: z.number().positive().nullable().optional(),
  fuelTerminal: z.boolean().optional(),
  containerTerminal: z.boolean().optional(),
  bulkTerminal: z.boolean().optional(),
  reeferCapable: z.boolean().optional(),
  customsClearanceDaysMedian: z.number().nonnegative().nullable().optional(),
  portDaysMedian: z.number().nonnegative().nullable().optional(),
  congestionFactor: z.number().positive().max(5).optional(),
  tariffNotes: z.string().max(2000).nullable().optional(),
  restrictedCargoNotes: z.string().max(2000).nullable().optional(),
  workingHours: z.string().max(60).nullable().optional(),
  pilotageRequired: z.boolean().optional(),
  localAgentOrgId: z.string().min(1).nullable().optional(),
} as const;

const CreatePortBody = z.object({
  unlocode: z
    .string()
    .transform((v) => v.trim().toUpperCase())
    .refine((v) => UNLOCODE_RE.test(v), {
      message: "unlocode must match [A-Z]{2}[A-Z0-9]{3}",
    }),
  ...PortCommonFields,
});

const UpdatePortBody = z
  .object({
    ...PortCommonFields,
    /** Bump lastVerifiedAt on save. */
    verify: z.boolean().optional(),
  })
  .partial();

const CreatePortEventBody = z.object({
  portId: z.string().min(1),
  eventType: z.enum([
    "closure",
    "congestion",
    "strike",
    "tariff_change",
    "regulatory",
  ]),
  severity: z.enum(["info", "warn", "critical"]).optional(),
  /** ISO-8601 timestamp. */
  startsAt: z.string().min(1),
  /** ISO-8601 timestamp; omit for ongoing. */
  endsAt: z.string().min(1).nullable().optional(),
  title: z.string().min(1).max(200),
  body: z.string().max(4000).nullable().optional(),
  sourceUrl: z.string().url().nullable().optional(),
});
