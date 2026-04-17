import {
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from "@nestjs/common";
import { readFile } from "node:fs/promises";
import { and, desc, eq, gte, lt, sql } from "drizzle-orm";
import { createId } from "@vex/domain";
import {
  schema,
  withTenant,
  type Db,
  type EventRepository,
  type WorkspaceRepository,
} from "@vex/db";
import type { WorkspaceSettings } from "@vex/db";
import {
  ADMIN_DB_CLIENT,
  ADMIN_EVAL_RESULTS_PATH,
  ADMIN_EVENTS_REPO,
  ADMIN_WORKSPACES_REPO,
} from "./tokens.js";

/**
 * OWNER-only admin surface. Every mutation goes through
 * `updateSettings` which stores an `admin.settings.updated` audit
 * event carrying a before / after diff so operators can trace every
 * flip.
 */

// ---------------------------------------------------------------------------
// Shapes
// ---------------------------------------------------------------------------

/**
 * Patch shape. `| undefined` on each field so the Zod-inferred type
 * (where `.optional()` produces `T | undefined`) assigns cleanly
 * under exactOptionalPropertyTypes.
 */
export interface SettingsPatch {
  enabled_agents?: string[] | undefined;
  kill_all_agents?: boolean | undefined;
  daily_cost_limit?: number | undefined;
  source_priority?: string[] | undefined;
  feature_rollout?: Record<string, number> | undefined;
  sharing_enabled?: boolean | undefined;
}

export interface HealthMetrics {
  window: { from: string; to: string };
  totalRuns: number;
  completed: number;
  failed: number;
  failureRate: number;
  avgDurationSeconds: number | null;
  totalCostUsd: number;
  byAgent: Array<{
    agentName: string;
    runs: number;
    failures: number;
    totalCostUsd: number;
    avgDurationSeconds: number | null;
  }>;
}

export interface CostLedgerEntry {
  id: string;
  operation: string;
  provider: string;
  model: string | null;
  agentRunId: string | null;
  agentName: string | null;
  units: number;
  unitKind: string;
  costUsd: number;
  occurredAt: string;
}

export interface CostLedgerPage {
  window: { from: string; to: string };
  entries: CostLedgerEntry[];
  totals: {
    today: number;
    week: number;
    month: number;
  };
}

export interface EvalFixtureResult {
  id: string;
  question: string;
  passed: boolean;
  errors?: string[];
}

export interface EvalResults {
  runAt: string;
  totalFixtures: number;
  passed: number;
  failed: number;
  passRate: number;
  regressions?: string[];
  fixtures: EvalFixtureResult[];
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

const MICROS_PER_USD = 1_000_000;

@Injectable()
export class AdminService {
  private readonly log = new Logger(AdminService.name);

  constructor(
    @Inject(ADMIN_DB_CLIENT) private readonly db: Db,
    @Inject(ADMIN_WORKSPACES_REPO)
    private readonly workspaces: WorkspaceRepository,
    @Inject(ADMIN_EVENTS_REPO) private readonly events: EventRepository,
    @Inject(ADMIN_EVAL_RESULTS_PATH) private readonly evalResultsPath: string,
  ) {}

  async getSettings(workspaceId: string): Promise<WorkspaceSettings> {
    // The workspaces table's RLS policy is `id = current_setting(
    // 'app.tenant_id', true)`. Without a session tenant, every row is
    // filtered out and getSettings returns null → the controller 404s.
    // Wrap in withTenant so the tenant_id session var is set to the
    // workspace id (which IS the tenant id in this product).
    const current = await withTenant(this.db, workspaceId, async () =>
      this.workspaces.getSettings(this.db, workspaceId),
    );
    if (!current) throw new NotFoundException(`workspace ${workspaceId}`);
    return current;
  }

  async updateSettings(
    tenantId: string,
    workspaceId: string,
    patch: SettingsPatch,
    actorUserId: string,
  ): Promise<WorkspaceSettings> {
    if (tenantId !== workspaceId) {
      // Every Vex workspace IS its own tenant; this mismatch implies a
      // cross-tenant admin attempt we should refuse loudly rather than
      // silently write to the wrong row.
      throw new ForbiddenException("cross-tenant settings write refused");
    }
    const current = await this.getSettings(workspaceId);
    const next: WorkspaceSettings = mergeSettings(current, patch);
    // Same RLS story as getSettings — the update needs the tenant_id
    // session var set or the WHERE id = $1 matches zero rows and
    // drizzle throws.
    const updated = await withTenant(this.db, workspaceId, async () =>
      this.workspaces.updateSettings(this.db, workspaceId, next),
    );
    await withTenant(this.db, tenantId, async (tx) => {
      await this.events.insertIfNotExists(tx, tenantId, {
        verb: "admin.settings.updated",
        subjectType: "workspace",
        subjectId: workspaceId,
        actorType: "user",
        actorId: actorUserId,
        objectType: "workspace",
        objectId: workspaceId,
        occurredAt: new Date(),
        idempotencyKey: `admin.settings.updated:${workspaceId}:${updated.updatedAt.toISOString()}`,
        metadata: {
          patch,
          before: current,
          after: next,
          audit_event_id: createId(),
        },
      });
    });
    this.log.log(
      `workspace ${workspaceId} settings updated by ${actorUserId}: ${Object.keys(patch).join(", ")}`,
    );
    return next;
  }

  async getHealthMetrics(tenantId: string): Promise<HealthMetrics> {
    const to = new Date();
    const from = new Date(to.getTime() - 7 * 24 * 60 * 60 * 1000);
    return withTenant(this.db, tenantId, async (tx) => {
      const overallRows = await tx
        .select({
          totalRuns: sql<number>`count(*)::int`,
          completed: sql<number>`count(*) filter (where ${schema.agentRuns.status} = 'completed')::int`,
          failed: sql<number>`count(*) filter (where ${schema.agentRuns.status} = 'failed')::int`,
          totalCostUsd: sql<number>`coalesce(sum(${schema.agentRuns.costUsd}), 0)`,
          avgDurationSeconds: sql<number | null>`avg(extract(epoch from (${schema.agentRuns.finishedAt} - ${schema.agentRuns.startedAt})))`,
        })
        .from(schema.agentRuns)
        .where(gte(schema.agentRuns.createdAt, from));
      const overall = overallRows[0] ?? {
        totalRuns: 0,
        completed: 0,
        failed: 0,
        totalCostUsd: 0,
        avgDurationSeconds: null,
      };

      const byAgentRows = await tx
        .select({
          agentName: schema.agentRuns.agentName,
          runs: sql<number>`count(*)::int`,
          failures: sql<number>`count(*) filter (where ${schema.agentRuns.status} = 'failed')::int`,
          totalCostUsd: sql<number>`coalesce(sum(${schema.agentRuns.costUsd}), 0)`,
          avgDurationSeconds: sql<number | null>`avg(extract(epoch from (${schema.agentRuns.finishedAt} - ${schema.agentRuns.startedAt})))`,
        })
        .from(schema.agentRuns)
        .where(gte(schema.agentRuns.createdAt, from))
        .groupBy(schema.agentRuns.agentName)
        .orderBy(desc(sql`count(*)`));

      const failureRate =
        overall.totalRuns > 0 ? overall.failed / overall.totalRuns : 0;

      return {
        window: { from: from.toISOString(), to: to.toISOString() },
        totalRuns: Number(overall.totalRuns ?? 0),
        completed: Number(overall.completed ?? 0),
        failed: Number(overall.failed ?? 0),
        failureRate,
        avgDurationSeconds:
          overall.avgDurationSeconds !== null
            ? Number(overall.avgDurationSeconds)
            : null,
        totalCostUsd: Number(overall.totalCostUsd ?? 0),
        byAgent: byAgentRows.map((r) => ({
          agentName: r.agentName,
          runs: Number(r.runs ?? 0),
          failures: Number(r.failures ?? 0),
          totalCostUsd: Number(r.totalCostUsd ?? 0),
          avgDurationSeconds:
            r.avgDurationSeconds !== null ? Number(r.avgDurationSeconds) : null,
        })),
      };
    });
  }

  async getCostLedger(
    tenantId: string,
    fromRaw?: string,
    toRaw?: string,
    limit = 200,
  ): Promise<CostLedgerPage> {
    const to = toRaw && !Number.isNaN(Date.parse(toRaw)) ? new Date(toRaw) : new Date();
    const defaultFrom = new Date(to.getTime() - 30 * 24 * 60 * 60 * 1000);
    const from =
      fromRaw && !Number.isNaN(Date.parse(fromRaw)) ? new Date(fromRaw) : defaultFrom;
    const clampedLimit = Math.max(1, Math.min(limit, 500));

    // cost_ledger's Drizzle schema exists but no migration has created
    // the table yet. Catch 42P01 relation-does-not-exist and serve
    // an empty page so the Cost tab renders instead of 500ing.
    try {
      return await withTenant(this.db, tenantId, async (tx) => {
      const entryRows = await tx
        .select({
          id: schema.costLedger.id,
          operation: schema.costLedger.operation,
          provider: schema.costLedger.provider,
          model: schema.costLedger.model,
          agentRunId: schema.costLedger.agentRunId,
          agentName: schema.agentRuns.agentName,
          units: schema.costLedger.units,
          unitKind: schema.costLedger.unitKind,
          costUsdMicros: schema.costLedger.costUsdMicros,
          occurredAt: schema.costLedger.occurredAt,
        })
        .from(schema.costLedger)
        .leftJoin(
          schema.agentRuns,
          eq(schema.costLedger.agentRunId, schema.agentRuns.id),
        )
        .where(
          and(
            gte(schema.costLedger.occurredAt, from),
            lt(schema.costLedger.occurredAt, to),
          ),
        )
        .orderBy(desc(schema.costLedger.occurredAt))
        .limit(clampedLimit);

      const totals = await sumTotals(tx, to);

      return {
        window: { from: from.toISOString(), to: to.toISOString() },
        entries: entryRows.map((r) => ({
          id: r.id as string,
          operation: r.operation,
          provider: r.provider,
          model: r.model ?? null,
          agentRunId: (r.agentRunId as string | null) ?? null,
          agentName: r.agentName ?? null,
          units: Number(r.units ?? 0),
          unitKind: r.unitKind,
          costUsd: Number(r.costUsdMicros) / MICROS_PER_USD,
          occurredAt: (r.occurredAt as Date).toISOString(),
        })),
        totals,
      };
      });
    } catch (err) {
      const code = (err as { code?: string }).code;
      if (code === "42P01") {
        return {
          window: { from: from.toISOString(), to: to.toISOString() },
          entries: [],
          totals: { today: 0, week: 0, month: 0 },
        };
      }
      throw err;
    }
  }

  async getLatestEvalResults(): Promise<EvalResults | null> {
    try {
      const raw = await readFile(this.evalResultsPath, "utf8");
      const parsed = JSON.parse(raw) as EvalResults;
      return parsed;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "ENOENT") return null;
      throw err;
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function mergeSettings(
  current: WorkspaceSettings,
  patch: SettingsPatch,
): WorkspaceSettings {
  const next: WorkspaceSettings = { ...current };
  if (patch.enabled_agents !== undefined) next.enabled_agents = patch.enabled_agents;
  if (patch.kill_all_agents !== undefined) next.kill_all_agents = patch.kill_all_agents;
  if (patch.daily_cost_limit !== undefined) next.daily_cost_limit = patch.daily_cost_limit;
  if (patch.source_priority !== undefined) next.source_priority = patch.source_priority;
  if (patch.feature_rollout !== undefined) next.feature_rollout = patch.feature_rollout;
  if (patch.sharing_enabled !== undefined) next.sharing_enabled = patch.sharing_enabled;
  return next;
}

async function sumTotals(
  tx: Parameters<Parameters<Db["transaction"]>[0]>[0],
  now: Date,
): Promise<{ today: number; week: number; month: number }> {
  const todayStart = new Date(now);
  todayStart.setUTCHours(0, 0, 0, 0);
  const weekStart = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
  const monthStart = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);

  const [row] = await tx
    .select({
      today: sql<number>`coalesce(sum(${schema.costLedger.costUsdMicros}) filter (where ${schema.costLedger.occurredAt} >= ${todayStart.toISOString()}::timestamptz), 0)::bigint`,
      week: sql<number>`coalesce(sum(${schema.costLedger.costUsdMicros}) filter (where ${schema.costLedger.occurredAt} >= ${weekStart.toISOString()}::timestamptz), 0)::bigint`,
      month: sql<number>`coalesce(sum(${schema.costLedger.costUsdMicros}) filter (where ${schema.costLedger.occurredAt} >= ${monthStart.toISOString()}::timestamptz), 0)::bigint`,
    })
    .from(schema.costLedger);
  return {
    today: Number(row?.today ?? 0) / MICROS_PER_USD,
    week: Number(row?.week ?? 0) / MICROS_PER_USD,
    month: Number(row?.month ?? 0) / MICROS_PER_USD,
  };
}
