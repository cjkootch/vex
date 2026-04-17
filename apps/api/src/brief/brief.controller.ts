import { Controller, Get, Inject, Query, UseGuards } from "@nestjs/common";
import { and, desc, eq, gte, sql } from "drizzle-orm";
import { JwtAuthGuard, TenantContext } from "../auth/index.js";
import {
  schema,
  withTenant,
  type ApprovalRepository,
  type Db,
  type SummaryRepository,
  type Tx,
} from "@vex/db";
import type { DailyBrief } from "@vex/domain";

/**
 * GET /brief/today   — latest daily brief for the current tenant.
 * GET /brief/history — last N brief rows (id, date, focus, priority count).
 *
 * The DailyBriefAgent persists a DailyBrief as JSON into
 * summaries.content under summary_type='daily_brief'. This controller
 * reads the latest row and overwrites two fields with live values
 * (pendingApprovalCount, totalAgentCostToday) before returning, so a
 * stale cached brief never shows an out-of-date badge.
 */

export const BRIEF_DB_CLIENT = Symbol("BRIEF_DB_CLIENT");
export const BRIEF_SUMMARY_REPO = Symbol("BRIEF_SUMMARY_REPO");
export const BRIEF_APPROVAL_REPO = Symbol("BRIEF_APPROVAL_REPO");

export interface BriefNotReady {
  status: "not_ready";
  message: string;
}

export interface BriefHistoryEntry {
  date: string;
  id: string;
  recommendedFocus: string;
  priorityCount: number;
}

const NOT_READY_MESSAGE = "Brief generates at 06:00 UTC on weekdays.";
const HISTORY_DEFAULT_LIMIT = 7;
const HISTORY_MAX_LIMIT = 30;

@Controller("brief")
@UseGuards(JwtAuthGuard)
export class BriefController {
  constructor(
    @Inject(TenantContext) private readonly tenant: TenantContext,
    @Inject(BRIEF_DB_CLIENT) private readonly db: Db,
    @Inject(BRIEF_SUMMARY_REPO) private readonly summaries: SummaryRepository,
    @Inject(BRIEF_APPROVAL_REPO) private readonly _approvals: ApprovalRepository,
  ) {
    // ApprovalRepository is accepted for future enhancements; count
    // queries currently run inline against the schema for a single-
    // round-trip pending-approval count.
    void this._approvals;
  }

  @Get("today")
  async today(): Promise<DailyBrief | BriefNotReady> {
    const { tenantId, workspaceId } = this.tenant;
    return withTenant(this.db, tenantId, async (tx) => {
      const latest = await this.summaries.getLatest(
        tx,
        "workspace",
        workspaceId,
        "daily_brief",
      );
      if (!latest) return notReady();
      const todayStart = startOfDayUtc();
      if (latest.createdAt.getTime() < todayStart.getTime()) return notReady();

      const brief = safeParseBrief(latest.content);
      if (!brief) return notReady();

      const [pendingApprovalCount, totalAgentCostToday] = await Promise.all([
        countPendingApprovals(tx),
        sumAgentCostSince(tx, todayStart),
      ]);
      return {
        ...brief,
        pendingApprovalCount,
        totalAgentCostToday,
      };
    });
  }

  @Get("history")
  async history(
    @Query("limit") raw?: string,
  ): Promise<{ briefs: BriefHistoryEntry[] }> {
    const limit = clampLimit(raw, HISTORY_DEFAULT_LIMIT, HISTORY_MAX_LIMIT);
    const { tenantId, workspaceId } = this.tenant;
    const briefs = await withTenant(this.db, tenantId, async (tx) => {
      const rows = await tx
        .select()
        .from(schema.summaries)
        .where(
          and(
            eq(schema.summaries.subjectType, "workspace"),
            eq(schema.summaries.subjectId, workspaceId),
            eq(schema.summaries.summaryType, "daily_brief"),
          ),
        )
        .orderBy(desc(schema.summaries.createdAt))
        .limit(limit);
      const out: BriefHistoryEntry[] = [];
      for (const row of rows) {
        const brief = safeParseBrief(row.content);
        if (!brief) continue;
        out.push({
          date: row.createdAt.toISOString(),
          id: row.id,
          recommendedFocus: brief.recommendedFocus ?? "",
          priorityCount: Array.isArray(brief.priorities)
            ? brief.priorities.length
            : 0,
        });
      }
      return out;
    });
    return { briefs };
  }
}

// ---------------------------------------------------------------------------
// Helpers — kept module-local so the controller reads top-to-bottom.
// ---------------------------------------------------------------------------

function notReady(): BriefNotReady {
  return { status: "not_ready", message: NOT_READY_MESSAGE };
}

function startOfDayUtc(): Date {
  const d = new Date();
  d.setUTCHours(0, 0, 0, 0);
  return d;
}

function clampLimit(
  raw: string | undefined,
  fallback: number,
  max: number,
): number {
  const parsed = raw ? Number.parseInt(raw, 10) : fallback;
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.min(parsed, max);
}

function safeParseBrief(content: string): DailyBrief | null {
  try {
    return JSON.parse(content) as DailyBrief;
  } catch {
    return null;
  }
}

async function countPendingApprovals(tx: Tx): Promise<number> {
  const rows = await tx
    .select({ n: sql<number>`count(*)` })
    .from(schema.approvals)
    .where(eq(schema.approvals.decision, "pending"));
  return Number(rows[0]?.n ?? 0);
}

async function sumAgentCostSince(tx: Tx, since: Date): Promise<number> {
  const rows = await tx
    .select({ s: sql<number>`coalesce(sum(${schema.agentRuns.costUsd}), 0)` })
    .from(schema.agentRuns)
    .where(gte(schema.agentRuns.createdAt, since));
  return Number(rows[0]?.s ?? 0);
}
