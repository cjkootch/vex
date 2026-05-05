import {
  Controller,
  Get,
  Inject,
  Query,
  UseGuards,
} from "@nestjs/common";
import { and, desc, eq, gte, inArray, or, sql, type SQL } from "drizzle-orm";
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
    @Query("scope_type") scopeType?: string,
    @Query("scope_id") scopeId?: string,
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
        // Scope filter — narrows the feed to runs that touched one
        // specific entity (deal, org, contact, campaign). Matches on
        // every reasonable key name because different agents stamp
        // different field names onto input_refs. "Close enough" beats
        // "perfect" here — if we miss a run the rail just won't show
        // it; we don't accidentally expose another tenant's data
        // (RLS still scopes the query).
        const scopeClause = buildScopeClause(scopeType, scopeId);
        if (scopeClause) conditions.push(scopeClause);
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
        // Hydrate contact names so the calls list (and any agent-run
        // feed scoped on contact_id in inputRefs) can render
        // "Outbound call to Cole Kutschinski (+1 832 492 7169)"
        // instead of the generic fallback "outbound_call pending".
        const contactIds = new Set<string>();
        for (const r of rows) {
          const refs = r.inputRefs as Record<string, unknown>;
          const cid = refs["contact_id"];
          if (typeof cid === "string" && cid.length > 0) contactIds.add(cid);
        }
        const contactNameById = new Map<string, string>();
        if (contactIds.size > 0) {
          const contactRows = await tx
            .select({
              id: schema.contacts.id,
              fullName: schema.contacts.fullName,
            })
            .from(schema.contacts)
            .where(inArray(schema.contacts.id, [...contactIds]));
          for (const c of contactRows) contactNameById.set(c.id, c.fullName);
        }
        return rows.map((r) =>
          toResponse(r, latestByRun.get(r.id) ?? null, contactNameById),
        );
      },
    );

    return { runs };
  }
}

/**
 * Map (scope_type, scope_id) to a Drizzle WHERE clause that matches
 * any agent run whose `input_refs` (or `output_refs`) JSONB carries
 * that id under a conventional key name.
 *
 * Keys checked per type:
 *   deal          → deal_id | dealId | deal_ref
 *   organization  → organization_id | org_id | orgId
 *   contact       → contact_id | contactId
 *   campaign      → campaign_id | campaignId
 *
 * Returns null when either param is missing/empty or the type is
 * unknown — the caller drops the clause and falls back to the global
 * feed.
 */
function buildScopeClause(
  scopeType: string | undefined,
  scopeId: string | undefined,
): SQL | null {
  if (!scopeType || !scopeId) return null;
  const t = scopeType.trim();
  const id = scopeId.trim();
  if (!t || !id) return null;

  const keys: readonly string[] = (() => {
    switch (t) {
      case "deal":
        return ["deal_id", "dealId", "deal_ref"];
      case "organization":
        return ["organization_id", "org_id", "orgId"];
      case "contact":
        return ["contact_id", "contactId"];
      case "campaign":
        return ["campaign_id", "campaignId"];
      default:
        return [];
    }
  })();
  if (keys.length === 0) return null;

  const predicates: SQL[] = [];
  for (const k of keys) {
    predicates.push(sql`${schema.agentRuns.inputRefs} ->> ${k} = ${id}`);
    predicates.push(sql`${schema.agentRuns.outputRefs} ->> ${k} = ${id}`);
  }
  return or(...predicates) ?? null;
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
  contactNameById: ReadonlyMap<string, string>,
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
    summary: buildSummary(row, contactNameById),
  };
}

function buildSummary(
  row: AgentRunRow,
  contactNameById: ReadonlyMap<string, string>,
): string {
  // Tier 1: outputRefs strings (agent stamps these on completion).
  const out = row.outputRefs;
  for (const key of PREFERRED_SUMMARY_KEYS) {
    const v = out[key];
    if (typeof v === "string" && v.length > 0) return v.slice(0, 120);
  }
  for (const v of Object.values(out)) {
    if (typeof v === "string" && v.length > 0) return v.slice(0, 120);
  }
  // Tier 2: synthesise from inputRefs for runs that haven't completed
  // yet (agent_name="outbound_call" + to_number / contact_id in
  // inputRefs is the dominant case here — covers the calls page's
  // "outbound_call pending" -> "Outbound call to Cole Kutschinski
  // (+18324927169)" upgrade).
  if (row.agentName === "outbound_call") {
    const refs = row.inputRefs as Record<string, unknown>;
    const contactId = typeof refs["contact_id"] === "string"
      ? (refs["contact_id"] as string)
      : null;
    const toNumber = typeof refs["to_number"] === "string"
      ? (refs["to_number"] as string)
      : null;
    const name = contactId ? contactNameById.get(contactId) ?? null : null;
    if (name && toNumber) {
      return `Outbound call to ${name} (${toNumber})`.slice(0, 120);
    }
    if (name) return `Outbound call to ${name}`.slice(0, 120);
    if (toNumber) return `Outbound call to ${toNumber}`.slice(0, 120);
  }
  // Tier 3: fall back to the generic agent_name + status line.
  return `${row.agentName} ${row.status}`;
}
