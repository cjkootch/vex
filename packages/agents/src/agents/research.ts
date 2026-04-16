import { TenantId, type EvidenceItem, type EvidencePack } from "@vex/domain";
import { RESEARCH_SYSTEM_PROMPT } from "../prompts/research.js";
import type { AgentContext, AgentOutput, IAgent } from "./types.js";

const TOUCHPOINT_LOOKBACK_DAYS = 30;

export interface ResearchAgentInput {
  organizationId: string;
}

/**
 * T0/T1 hybrid: produces a research brief (T0 — read-only summary) and
 * may update org.fit_score field_confidence (T1 — internal write, audited).
 *
 * Triggered by AgentScanner per organization.
 */
export class ResearchAgent implements IAgent {
  readonly name = "research";
  readonly tier = "T1" as const;

  constructor(private readonly input: ResearchAgentInput) {}

  async run(ctx: AgentContext): Promise<AgentOutput> {
    const org = await ctx.organizations.findById(ctx.tx, this.input.organizationId);
    if (!org) {
      return {
        costUsd: 0,
        outputRefs: { skipped: "org_not_found" },
        proposedActions: [],
        internalWrites: 0,
        rationale: `org ${this.input.organizationId} not in scope`,
      };
    }

    const since = new Date(Date.now() - TOUCHPOINT_LOOKBACK_DAYS * 24 * 60 * 60 * 1000);
    const touchpoints = await ctx.touchpoints.listForOrgSince(ctx.tx, org.id, since, 30);
    const evidencePack = buildPack(org, touchpoints);

    const result = await ctx.anthropic.query({
      tenantId: TenantId(ctx.tenantId),
      idempotencyKey: `research:${ctx.agentRunId}`,
      systemPrompt: RESEARCH_SYSTEM_PROMPT,
      evidencePack,
      userMessage: `Research org ${org.legalName} (${org.id}). Update fit_score if you have evidence.`,
      maxTokens: 1500,
    });

    const summary = await ctx.summaries.upsert(ctx.tx, ctx.tenantId, {
      subjectType: "organization",
      subjectId: org.id,
      summaryType: "research_brief",
      content: result.answer,
    });

    let internalWrites = 1;
    let confidenceDelta = 0;

    // T1 fit_score update — apply directly when confidence >= 0.4 (the
    // research prompt is instructed to return 0.0 when it can't justify a
    // change). T2+ would have been routed through ApprovalGate by the
    // runner; this is a T1 internal write so we apply it here.
    const fitAction = result.proposedActions.find(
      (a) => a.kind === "research.fit_score" && a.tier === "T1",
    );
    if (fitAction) {
      const fitScore = Number(fitAction.payload["fit_score"]);
      const confidence = Number(fitAction.payload["confidence"]);
      if (Number.isFinite(fitScore) && Number.isFinite(confidence) && confidence >= 0.4) {
        await ctx.organizations.updateFieldConfidence(
          ctx.tx,
          org.id,
          "fit_score",
          fitScore,
          "agent.research",
          confidence,
        );
        internalWrites++;
        confidenceDelta = confidence;
      }
    }

    return {
      costUsd: result.costUsd,
      outputRefs: {
        summary_id: summary.id,
        org_id: org.id,
        confidence_delta: confidenceDelta,
      },
      proposedActions: result.proposedActions.filter(
        (a) => a.tier === "T2" || a.tier === "T3",
      ),
      internalWrites,
      rationale: `${touchpoints.length} touchpoints over ${TOUCHPOINT_LOOKBACK_DAYS}d`,
    };
  }
}

function buildPack(
  org: { id: string; legalName: string; industry: string | null; fitScore: number | null },
  touchpoints: { id: string; channel: string; occurredAt: Date; metadata: Record<string, unknown> }[],
): EvidencePack {
  const now = Date.now();
  const summaries: EvidenceItem[] = [
    {
      chunk_id: org.id,
      object_type: "organization",
      object_id: org.id,
      chunk_text: `${org.legalName} (industry=${org.industry ?? "unknown"}, fit_score=${org.fitScore ?? "unset"})`,
      source_ref: `organization ${org.id}`,
      source_type: "summary",
      occurred_at: new Date(),
      freshness_hours: 0,
      confidence_score: 1,
      corroborated_by_count: 0,
      permission_scope: "workspace",
      raw_event_ref: null,
      summary_version: 0,
    },
  ];
  const items: EvidenceItem[] = touchpoints.map((t) => ({
    chunk_id: t.id,
    object_type: "touchpoint",
    object_id: t.id,
    chunk_text: `${t.channel} at ${t.occurredAt.toISOString()} ${JSON.stringify(t.metadata)}`,
    source_ref: `touchpoint ${t.id}`,
    source_type: "event",
    occurred_at: t.occurredAt,
    freshness_hours: Math.max(0, (now - t.occurredAt.getTime()) / 3_600_000),
    confidence_score: 0.7,
    corroborated_by_count: 0,
    permission_scope: "workspace",
    raw_event_ref: null,
    summary_version: null,
  }));
  return {
    summaries,
    items,
    estimated_tokens: summaries.length * 30 + items.length * 30,
  };
}
