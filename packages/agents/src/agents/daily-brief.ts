import { TenantId, type EvidencePack, type EvidenceItem } from "@vex/domain";
import { validateManifest } from "@vex/ui";
import { DAILY_BRIEF_SYSTEM_PROMPT } from "../prompts/daily-brief.js";
import type { AgentContext, AgentOutput, IAgent } from "./types.js";

const LOOKBACK_HOURS = 24;
const MAX_TOUCHPOINTS = 80;

/**
 * T0 read-only summariser. Runs daily at 06:00 UTC (workspace timezone
 * support lands in Sprint 10). Produces a ViewManifest stored under
 * `summary_type = "daily_brief"` so the chat surface can replay it.
 */
export class DailyBriefAgent implements IAgent {
  readonly name = "daily_brief";
  readonly tier = "T0" as const;

  async run(ctx: AgentContext): Promise<AgentOutput> {
    const since = new Date(Date.now() - LOOKBACK_HOURS * 60 * 60 * 1000);
    const recent = await ctx.touchpoints.listSince(ctx.tx, since, MAX_TOUCHPOINTS);
    const staleLeads = await ctx.leads.listStale(
      ctx.tx,
      new Date(Date.now() - 14 * 24 * 60 * 60 * 1000),
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
    if (!validation.success) {
      // Brief is still saved as a text-only summary — Sprint 10 will retry.
      const summary = await ctx.summaries.upsert(ctx.tx, ctx.tenantId, {
        subjectType: "workspace",
        subjectId: ctx.workspaceId,
        summaryType: "daily_brief",
        content: result.answer || "Vex couldn't compose today's brief.",
      });
      return {
        costUsd: result.costUsd,
        outputRefs: { summary_id: summary.id, manifest_valid: false },
        proposedActions: [],
        internalWrites: 1,
        rationale: `manifest_invalid: ${validation.error.slice(0, 80)}`,
      };
    }

    const summary = await ctx.summaries.upsert(ctx.tx, ctx.tenantId, {
      subjectType: "workspace",
      subjectId: ctx.workspaceId,
      summaryType: "daily_brief",
      content: JSON.stringify({
        answer: result.answer,
        manifest: validation.manifest,
      }),
    });

    return {
      costUsd: result.costUsd,
      outputRefs: {
        summary_id: summary.id,
        manifest_valid: true,
        panels: validation.manifest.panels.length,
        cache_read_tokens: result.cacheReadTokens,
      },
      proposedActions: [],
      internalWrites: 1,
      rationale: `${recent.length} touchpoints, ${staleLeads.length} stale leads`,
    };
  }
}

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
