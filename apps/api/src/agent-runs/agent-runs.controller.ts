import {
  Controller,
  Get,
  Inject,
  Query,
  UseGuards,
} from "@nestjs/common";
import { and, desc, eq, gte, inArray, type SQL } from "drizzle-orm";
import { JwtAuthGuard, TenantContext } from "../auth/index.js";
import {
  withTenant,
  schema,
  type AgentRunRepository,
  type ApprovalRepository,
  type Db,
} from "@vex/db";

/**
 * GET /agent-runs
 *
 * Serves the AutonomyFeed on the web client. All reads scope to the
 * caller's tenant via `withTenant`; query-level RLS applies in addition.
 *
 * Query params:
 *   - limit   (default 20, hard-capped at 50)
 *   - status  (optional — pending | running | completed | failed)
 *   - since   (optional — ISO 8601 date; runs with startedAt >= since)
 *
 * Each row joins the latest related approval (by createdAt desc) so
 * the feed can surface `has_approval` and `approval_status` without a
 * second round-trip.
 */

export const AGENT_RUNS_DB_CLIENT = Symbol("AGENT_RUNS_DB_CLIENT");
export const AGENT_RUNS_REPO = Symbol("AGENT_RUNS_REPO");
export const AGENT_RUNS_APPROVAL_REPO = Symbol("AGENT_RUNS_APPROVAL_REPO");

type AgentRunRow = typeof schema.agentRuns.$inferSelect;
type ApprovalRow = typeof schema.approvals.$inferSelect;

export interface AgentRunResponseItem {
  id: string;
  agent_name: string;
  status: string;
  started_at: string | null;
  finished_at: string | null;
  cost_usd: number;
  error: string | null;
  has_approval: boolean;
  approval_status: string | null;
  summary: string;
}

const ALLOWED_STATUSES = new Set([
  "pending",
  "running",
  "completed",
  "failed",
]);

// Fields in outputRefs that commonly carry a human-readable line. Ordered
// by how descriptive they usually are; first match wins.
const PREFERRED_SUMMARY_KEYS = [
  "rationale",
  "summary",
  "answer",
  "recommendation",
  "deal_ref",
];

@Controller("agent-runs")
@UseGuards(JwtAuthGuard)
export class AgentRunsController {
  // AgentRunRepository is accepted so future enhancements can route
  // through it; this controller currently reads via schema tables so
  // filtering by status + since can run in a single query.
  constructor(
    @Inject(TenantContext) private readonly tenant: TenantContext,
    @Inject(AGENT_RUNS_DB_CLIENT) private readonly db: Db,
    @Inject(AGENT_RUNS_REPO) private readonly _agentRuns: AgentRunRepository,
    @Inject(AGENT_RUNS_APPROVAL_REPO)
    private readonly _approvals: ApprovalRepository,
  ) {
    void this._agentRuns;
    void this._approvals;
  }

  @Get()
  async list(
    @Query("limit") limitRaw?: string,
    @Query("status") status?: string,
    @Query("since") since?: string,
  ): Promise<{ runs: AgentRunResponseItem[] }> {
    const limit = clampLimit(limitRaw);
    const statusFilter = status && ALLOWED_STATUSES.has(status) ? status : null;
    const sinceDate = parseSince(since);

    const runs = await withTenant(
      this.db,
      this.tenant.tenantId,
      async (tx) => {
        const conditions: SQL[] = [];
        if (statusFilter) {
          // Enum cast — Drizzle typing accepts the literal string here.
          conditions.push(
            eq(schema.agentRuns.status, statusFilter as AgentRunRow["status"]),
          );
        }
        if (sinceDate) {
          conditions.push(gte(schema.agentRuns.startedAt, sinceDate));
        }
        const q = tx.select().from(schema.agentRuns);
        const filtered = conditions.length
          ? q.where(and(...conditions))
          : q;
        const rows = await filtered
          .orderBy(desc(schema.agentRuns.createdAt))
          .limit(limit);

        if (rows.length === 0) return [];
        const ids = rows.map((r) => r.id);
        const approvals = await tx
          .select()
          .from(schema.approvals)
          .where(inArray(schema.approvals.agentRunId, ids))
          .orderBy(desc(schema.approvals.createdAt));
        const latestByRun = new Map<string, ApprovalRow>();
        for (const a of approvals) {
          if (a.agentRunId && !latestByRun.has(a.agentRunId)) {
            latestByRun.set(a.agentRunId, a);
          }
        }
        return rows.map((r) => toResponse(r, latestByRun.get(r.id) ?? null));
      },
    );

    return { runs };
  }
}

function clampLimit(raw: string | undefined): number {
  const parsed = raw ? Number.parseInt(raw, 10) : 20;
  if (!Number.isFinite(parsed) || parsed <= 0) return 20;
  return Math.min(parsed, 50);
}

function parseSince(raw: string | undefined): Date | null {
  if (!raw) return null;
  const d = new Date(raw);
  return Number.isNaN(d.getTime()) ? null : d;
}

function toResponse(
  row: AgentRunRow,
  approval: ApprovalRow | null,
): AgentRunResponseItem {
  return {
    id: row.id,
    agent_name: row.agentName,
    status: row.status,
    started_at: row.startedAt ? row.startedAt.toISOString() : null,
    finished_at: row.finishedAt ? row.finishedAt.toISOString() : null,
    cost_usd: row.costUsd,
    error: row.error ?? null,
    has_approval: approval !== null,
    approval_status: approval?.decision ?? null,
    summary: buildSummary(row),
  };
}

function buildSummary(row: AgentRunRow): string {
  const refs = row.outputRefs;
  for (const key of PREFERRED_SUMMARY_KEYS) {
    const v = refs[key];
    if (typeof v === "string" && v.length > 0) return v.slice(0, 120);
  }
  for (const v of Object.values(refs)) {
    if (typeof v === "string" && v.length > 0) return v.slice(0, 120);
  }
  return `${row.agentName} ${row.status}`;
}
