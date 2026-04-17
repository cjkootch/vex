import { and, desc, eq, gte, inArray } from "drizzle-orm";
import {
  TenantId,
  createId,
  type EvidenceItem,
  type EvidencePack,
  type BriefBlockedItem,
  type BriefHandledItem,
  type BriefPipelineItem,
  type BriefPriority,
  type BriefRisk,
  type DailyBrief,
} from "@vex/domain";
import { schema, type Tx } from "@vex/db";
import { validateManifest, vexCopy } from "@vex/ui";
import { DAILY_BRIEF_SYSTEM_PROMPT } from "../prompts/daily-brief.js";
import type { AgentContext, AgentOutput, IAgent } from "./types.js";

/**
 * T0 read-only summariser. Runs daily at 06:00 UTC. Writes TWO
 * summary rows per run:
 *   summary_type='daily_brief'         — DailyBrief JSON consumed by
 *                                         GET /brief/today and the
 *                                         /app home screen.
 *   summary_type='daily_brief_canvas'  — { answer, manifest } JSON
 *                                         for the chat-surface
 *                                         ViewManifest replay.
 *
 * The structured DailyBrief is assembled deterministically from
 * persisted rows (agent_runs, fuel_deals, scenarios, approvals,
 * leads). Claude still authors the ViewManifest + a one-sentence
 * recommended focus — we extract that sentence from result.answer.
 */

const LOOKBACK_HOURS = 24;
const MAX_TOUCHPOINTS = 80;
const STALE_LEAD_DAYS = 5;
const HANDLED_WINDOW_MS = 24 * 60 * 60 * 1000;

export class DailyBriefAgent implements IAgent {
  readonly name = "daily_brief";
  readonly tier = "T0" as const;

  async run(ctx: AgentContext): Promise<AgentOutput> {
    const since = new Date(Date.now() - LOOKBACK_HOURS * 60 * 60 * 1000);
    const recent = await ctx.touchpoints.listSince(ctx.tx, since, MAX_TOUCHPOINTS);
    const staleLeads = await ctx.leads.listStale(
      ctx.tx,
      new Date(Date.now() - STALE_LEAD_DAYS * 24 * 60 * 60 * 1000),
      20,
    );

    const evidencePack = buildPack(recent, staleLeads);

    const result = await ctx.anthropic.query({
      tenantId: TenantId(ctx.tenantId),
      idempotencyKey: `daily_brief:${ctx.agentRunId}`,
      systemPrompt: DAILY_BRIEF_SYSTEM_PROMPT,
      evidencePack,
      userMessage: "Produce today's morning brief for the workspace.",
      maxTokens: 1500,
    });

    const validation = validateManifest(result.viewManifest);
    const answerText = result.answer ?? "";

    // Assemble the structured DailyBrief from persisted rows. Each
    // builder is best-effort: query failures zero out that section
    // rather than blow up the whole brief.
    const [handled, pendingApprovals, pipeline, failedRuns, blockedDeals] =
      await Promise.all([
        fetchHandled(ctx.tx),
        fetchPendingApprovals(ctx.tx),
        fetchPipeline(ctx.tx),
        fetchFailedRuns(ctx.tx),
        fetchBlockedDeals(ctx.tx),
      ]);

    const priorities = buildPriorities(staleLeads, pendingApprovals, pipeline);
    const blocked = buildBlocked(failedRuns, blockedDeals);
    const risks = buildRisks(pipeline, blockedDeals);

    const dailyBrief: DailyBrief = {
      id: createId(),
      tenantId: ctx.tenantId,
      generatedAt: new Date().toISOString(),
      greeting: greetingForHour(new Date().getUTCHours()),
      priorities,
      handled,
      blocked,
      ownerOnly: [],
      pipeline,
      risks,
      recommendedFocus: firstSentence(answerText) || "Focus on today's priorities.",
      // Overridden by the /brief/today endpoint with live counts.
      totalAgentCostToday: 0,
      pendingApprovalCount: pendingApprovals.length,
    };

    const briefSummary = await ctx.summaries.upsert(ctx.tx, ctx.tenantId, {
      subjectType: "workspace",
      subjectId: ctx.workspaceId,
      summaryType: "daily_brief",
      content: JSON.stringify(dailyBrief),
    });

    // Canvas manifest — kept so the chat surface can replay the brief.
    // When the manifest fails to validate we still write the row with
    // the raw answer so there's something to render.
    const canvasContent = validation.success
      ? JSON.stringify({ answer: answerText, manifest: validation.manifest })
      : JSON.stringify({ answer: answerText, manifest: null });
    const canvasSummary = await ctx.summaries.upsert(ctx.tx, ctx.tenantId, {
      subjectType: "workspace",
      subjectId: ctx.workspaceId,
      summaryType: "daily_brief_canvas",
      content: canvasContent,
    });

    return {
      costUsd: result.costUsd,
      outputRefs: {
        brief_summary_id: briefSummary.id,
        canvas_summary_id: canvasSummary.id,
        manifest_valid: validation.success,
        priorities: priorities.length,
        pipeline: pipeline.length,
        handled: handled.length,
        blocked: blocked.length,
        risks: risks.length,
        cache_read_tokens: result.cacheReadTokens,
      },
      proposedActions: [],
      internalWrites: 2,
      rationale: `${priorities.length} priorities, ${pipeline.length} pipeline, ${handled.length} handled`,
    };
  }
}

// ---------------------------------------------------------------------------
// Deterministic DailyBrief assembly
// ---------------------------------------------------------------------------

function greetingForHour(utcHour: number): string {
  // UTC < 12 is treated as morning — a rough proxy until workspace
  // timezone support lands; matches the Sprint-10 comment in run().
  return utcHour < 12
    ? vexCopy.brief.greeting_morning
    : vexCopy.brief.greeting_afternoon;
}

function firstSentence(text: string): string {
  const trimmed = text.trim();
  if (!trimmed) return "";
  const match = trimmed.match(/^[^.!?]*[.!?]/);
  return (match ? match[0] : trimmed).slice(0, 280);
}

type AgentRunRow = typeof schema.agentRuns.$inferSelect;
type ApprovalRow = typeof schema.approvals.$inferSelect;
type FuelDealRow = typeof schema.fuelDeals.$inferSelect;
type ScenarioRow = typeof schema.fuelDealScenarios.$inferSelect;

async function fetchHandled(tx: Tx): Promise<BriefHandledItem[]> {
  const since = new Date(Date.now() - HANDLED_WINDOW_MS);
  const rows = await tx
    .select()
    .from(schema.agentRuns)
    .where(
      and(
        eq(schema.agentRuns.status, "completed"),
        gte(schema.agentRuns.finishedAt, since),
      ),
    )
    .orderBy(desc(schema.agentRuns.finishedAt))
    .limit(10);
  return rows.map((r) => ({
    id: r.id,
    agentName: r.agentName,
    summary: extractRunSummary(r),
    completedAt: (r.finishedAt ?? r.createdAt).toISOString(),
    costUsd: r.costUsd,
  }));
}

function extractRunSummary(row: AgentRunRow): string {
  const refs = row.outputRefs;
  for (const key of ["rationale", "summary", "recommendation", "answer"]) {
    const v = refs[key];
    if (typeof v === "string" && v.length > 0) return v.slice(0, 160);
  }
  return `${row.agentName} completed`;
}

async function fetchPendingApprovals(tx: Tx): Promise<ApprovalRow[]> {
  return tx
    .select()
    .from(schema.approvals)
    .where(eq(schema.approvals.decision, "pending"))
    .orderBy(desc(schema.approvals.createdAt))
    .limit(25);
}

async function fetchFailedRuns(tx: Tx): Promise<AgentRunRow[]> {
  const since = new Date(Date.now() - HANDLED_WINDOW_MS);
  return tx
    .select()
    .from(schema.agentRuns)
    .where(
      and(
        eq(schema.agentRuns.status, "failed"),
        gte(schema.agentRuns.createdAt, since),
      ),
    )
    .orderBy(desc(schema.agentRuns.createdAt))
    .limit(10);
}

async function fetchBlockedDeals(tx: Tx): Promise<FuelDealRow[]> {
  return tx
    .select()
    .from(schema.fuelDeals)
    .where(eq(schema.fuelDeals.complianceHold, true))
    .limit(25);
}

async function fetchPipeline(tx: Tx): Promise<BriefPipelineItem[]> {
  const activeStatuses: FuelDealRow["status"][] = [
    "negotiating",
    "pending_approval",
    "approved",
    "loading",
    "in_transit",
  ];
  const deals = await tx
    .select()
    .from(schema.fuelDeals)
    .where(inArray(schema.fuelDeals.status, activeStatuses))
    .orderBy(desc(schema.fuelDeals.updatedAt))
    .limit(20);
  if (deals.length === 0) return [];

  const dealIds = deals.map((d) => d.id);
  const scenarios = await tx
    .select()
    .from(schema.fuelDealScenarios)
    .where(
      and(
        inArray(schema.fuelDealScenarios.dealId, dealIds),
        eq(schema.fuelDealScenarios.isActive, true),
      ),
    );
  const scenarioByDeal = new Map<string, ScenarioRow>();
  for (const s of scenarios) {
    if (!scenarioByDeal.has(s.dealId)) scenarioByDeal.set(s.dealId, s);
  }

  // Buyer name lookup — single pass over organizations.
  const buyerIds = Array.from(new Set(deals.map((d) => d.buyerOrgId)));
  const buyers = buyerIds.length
    ? await tx
        .select()
        .from(schema.organizations)
        .where(inArray(schema.organizations.id, buyerIds))
    : [];
  const buyerName = new Map(buyers.map((b) => [b.id, b.legalName]));

  return deals.map<BriefPipelineItem>((d) => {
    const scenario = scenarioByDeal.get(d.id) ?? null;
    const results = scenario?.resultsJson as Record<string, unknown> | undefined;
    const totals = (results?.totals ?? {}) as { ebitdaUsd?: number };
    const scorecard = (results?.scorecard ?? {}) as { overallScore?: number };
    const warnings = Array.isArray(results?.warnings)
      ? (results.warnings as Array<{ severity?: string }>)
      : [];
    const criticalCount = warnings.filter((w) => w.severity === "critical").length;
    return {
      dealId: d.id,
      dealRef: d.dealRef,
      product: d.product,
      buyer: buyerName.get(d.buyerOrgId) ?? "Unknown buyer",
      status: d.status,
      ebitdaUsd: totals.ebitdaUsd ?? 0,
      score: scorecard.overallScore ?? scenario?.score ?? 0,
      recommendation: scenario?.recommendation ?? "n/a",
      daysSinceLastTouch: daysSince(d.updatedAt),
      criticalWarningCount: criticalCount,
    };
  });
}

function daysSince(d: Date): number {
  return Math.floor((Date.now() - d.getTime()) / (24 * 60 * 60 * 1000));
}

function buildPriorities(
  staleLeads: { id: string; status: string; updatedAt: Date; orgId: string }[],
  pendingApprovals: ApprovalRow[],
  pipeline: BriefPipelineItem[],
): BriefPriority[] {
  const out: BriefPriority[] = [];
  for (const approval of pendingApprovals.slice(0, 5)) {
    out.push({
      id: `approval:${approval.id}`,
      title: `Pending approval: ${approval.actionType}`,
      reason: "Action is waiting on your review.",
      objectType: "approval",
      objectId: approval.id,
      urgency: "high",
      approvalId: approval.id,
      suggestedAction: "Review in the approval inbox.",
    });
  }
  for (const lead of staleLeads.slice(0, 5)) {
    out.push({
      id: `lead:${lead.id}`,
      title: `Lead silent ${daysSince(lead.updatedAt)}d — status ${lead.status}`,
      reason: "No touchpoint recorded in the last 5 days.",
      objectType: "organization",
      objectId: lead.orgId,
      urgency: "medium",
      suggestedAction: "Send a check-in message.",
    });
  }
  for (const d of pipeline.filter(
    (p) => p.criticalWarningCount > 0 || p.daysSinceLastTouch > 7,
  )) {
    out.push({
      id: `deal:${d.dealId}`,
      title: `${d.dealRef} — ${d.recommendation}`,
      reason:
        d.criticalWarningCount > 0
          ? `${d.criticalWarningCount} critical warning${d.criticalWarningCount === 1 ? "" : "s"}.`
          : `${d.daysSinceLastTouch} days since last touch.`,
      objectType: "deal",
      objectId: d.dealId,
      objectRef: d.dealRef,
      urgency: d.criticalWarningCount > 0 ? "high" : "medium",
    });
  }
  return out;
}

function buildBlocked(
  failedRuns: AgentRunRow[],
  blockedDeals: FuelDealRow[],
): BriefBlockedItem[] {
  const out: BriefBlockedItem[] = [];
  for (const r of failedRuns) {
    out.push({
      id: `run:${r.id}`,
      summary: `${r.agentName} failed`,
      reason: r.error ?? "Unknown error.",
      objectType: "agent_run",
      objectId: r.id,
      resolution: "Inspect the run detail and retry once the root cause is clear.",
    });
  }
  for (const d of blockedDeals) {
    out.push({
      id: `deal-hold:${d.id}`,
      summary: `${d.dealRef} on compliance hold`,
      reason: d.complianceNotes ?? "Compliance hold flagged — details in the deal record.",
      objectType: "deal",
      objectId: d.id,
      ...(d.complianceNotes
        ? { resolution: "Clear the compliance gate (OFAC / BIS / EEI) in the deal tab." }
        : {}),
    });
  }
  return out;
}

function buildRisks(
  pipeline: BriefPipelineItem[],
  blockedDeals: FuelDealRow[],
): BriefRisk[] {
  const out: BriefRisk[] = [];
  for (const d of pipeline.filter((p) => p.criticalWarningCount > 0)) {
    out.push({
      id: `risk:${d.dealId}`,
      title: `${d.dealRef}: ${d.criticalWarningCount} critical warning${d.criticalWarningCount === 1 ? "" : "s"}`,
      severity: "high",
      description: `Score ${d.score.toFixed(0)} · recommendation ${d.recommendation}.`,
      objectType: "deal",
      objectId: d.dealId,
    });
  }
  for (const d of blockedDeals) {
    out.push({
      id: `risk-hold:${d.id}`,
      title: `${d.dealRef} blocked`,
      severity: "medium",
      description: d.complianceNotes ?? "Compliance hold in effect.",
      objectType: "deal",
      objectId: d.id,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Evidence pack — unchanged from pre-Sprint-11 behaviour, kept so Claude
// sees the same inputs and the ViewManifest stays consistent.
// ---------------------------------------------------------------------------

function buildPack(
  recent: { id: string; channel: string; occurredAt: Date; metadata: Record<string, unknown> }[],
  staleLeads: { id: string; status: string; updatedAt: Date }[],
): EvidencePack {
  const items: EvidenceItem[] = [];
  const now = Date.now();
  for (const t of recent) {
    items.push({
      chunk_id: t.id,
      object_type: "touchpoint",
      object_id: t.id,
      chunk_text: `touchpoint via ${t.channel} at ${t.occurredAt.toISOString()} ${JSON.stringify(t.metadata)}`,
      source_ref: `touchpoint ${t.id}`,
      source_type: "event",
      occurred_at: t.occurredAt,
      freshness_hours: Math.max(0, (now - t.occurredAt.getTime()) / 3_600_000),
      confidence_score: 0.8,
      corroborated_by_count: 0,
      permission_scope: "workspace",
      raw_event_ref: null,
      summary_version: null,
    });
  }
  const summaries: EvidenceItem[] = [];
  for (const lead of staleLeads) {
    summaries.push({
      chunk_id: lead.id,
      object_type: "lead",
      object_id: lead.id,
      chunk_text: `lead status=${lead.status} last_updated=${lead.updatedAt.toISOString()} (stale)`,
      source_ref: `lead ${lead.id}`,
      source_type: "summary",
      occurred_at: lead.updatedAt,
      freshness_hours: Math.max(0, (now - lead.updatedAt.getTime()) / 3_600_000),
      confidence_score: 0.9,
      corroborated_by_count: 0,
      permission_scope: "workspace",
      raw_event_ref: null,
      summary_version: 0,
    });
  }
  return {
    summaries,
    items,
    estimated_tokens: items.length * 30 + summaries.length * 30,
  };
}
