import { TenantId, type EvidenceItem, type EvidencePack } from "@vex/domain";
import type { ProposedAction } from "@vex/integrations";
import { FOLLOW_UP_SYSTEM_PROMPT } from "../prompts/follow-up.js";
import type { AgentContext, AgentOutput, IAgent } from "./types.js";

const STALE_THREAD_HOURS = 48;
const STALE_LEAD_DAYS = 7;
const MAX_SUGGESTIONS = 10;

/**
 * T1 cron agent. Surfaces stale threads + stalled leads, asks Claude to
 * draft a single follow-up suggestion per item, and creates an
 * `approvals` row per suggestion. Never sends — Sprint 7 wires the
 * "approve → execute" path.
 *
 * Tier T1 because the *suggestion* is an internal write (audit only);
 * the actual email send would be T2 and would require human approval at
 * the per-suggestion level. Sprint 6 stops at the suggestion step.
 */
export class FollowUpAgent implements IAgent {
  readonly name = "follow_up";
  readonly tier = "T1" as const;

  async run(ctx: AgentContext): Promise<AgentOutput> {
    const threadCutoff = new Date(Date.now() - STALE_THREAD_HOURS * 60 * 60 * 1000);
    const leadCutoff = new Date(Date.now() - STALE_LEAD_DAYS * 24 * 60 * 60 * 1000);

    const [threads, leads] = await Promise.all([
      ctx.threads.listStale(ctx.tx, threadCutoff, 25),
      ctx.leads.listStale(ctx.tx, leadCutoff, 25),
    ]);

    if (threads.length + leads.length === 0) {
      return {
        costUsd: 0,
        outputRefs: { stale_count: 0 },
        proposedActions: [],
        internalWrites: 0,
        rationale: "no stale items",
      };
    }

    const evidencePack = buildPack(threads, leads);

    const result = await ctx.anthropic.query({
      tenantId: TenantId(ctx.tenantId),
      idempotencyKey: `follow_up:${ctx.agentRunId}`,
      systemPrompt: FOLLOW_UP_SYSTEM_PROMPT,
      evidencePack,
      userMessage:
        "Draft up to one follow-up suggestion per stale item. Output proposed_actions only.",
      maxTokens: 2000,
    });

    // T1 suggestions: write each one as an approval row directly via the
    // approval repository (the runner only auto-gates T2+; for T1 we want
    // the suggestion stored in approvals so the inbox can review). The
    // ApprovalGate writes the audit event for each.
    const suggestions = result.proposedActions
      .filter((a) => a.kind === "follow_up.suggestion" && a.tier === "T1")
      .slice(0, MAX_SUGGESTIONS);

    const created: { approval_id: string; subject_id: string }[] = [];
    for (const suggestion of suggestions) {
      const approval = await ctx.approvals.create(ctx.tx, ctx.tenantId, {
        agentRunId: ctx.agentRunId,
        actionType: suggestion.kind,
        proposedPayload: {
          ...suggestion.payload,
          tier: suggestion.tier,
          rationale: suggestion.rationale,
        },
      });
      const subjectId =
        typeof suggestion.payload["subject_id"] === "string"
          ? (suggestion.payload["subject_id"] as string)
          : "unknown";
      created.push({ approval_id: approval.id, subject_id: subjectId });

      await ctx.events.insertIfNotExists(ctx.tx, ctx.tenantId, {
        verb: "agent.follow_up.suggestion_created",
        subjectType: "approval",
        subjectId: approval.id,
        actorType: "system",
        actorId: "follow_up",
        objectType: "approval",
        objectId: approval.id,
        occurredAt: new Date(),
        idempotencyKey: `follow_up.suggestion:${approval.id}`,
        metadata: { subject_id: subjectId, agent_run_id: ctx.agentRunId },
      });
    }

    // The runner's "audit + approval gate" pass operates on
    // proposed_actions; we've already created approvals here, so return
    // an empty list to avoid duplicate rows.
    return {
      costUsd: result.costUsd,
      outputRefs: {
        stale_threads: threads.length,
        stale_leads: leads.length,
        approvals_created: created.length,
        approvals: created,
      },
      proposedActions: [] as ProposedAction[],
      internalWrites: created.length,
      rationale: `${created.length} suggestions queued for review`,
    };
  }
}

function buildPack(
  threads: { id: string; channel: string; subject: string | null; lastMessageAt: Date | null }[],
  leads: { id: string; status: string; updatedAt: Date }[],
): EvidencePack {
  const now = Date.now();
  const items: EvidenceItem[] = [];

  for (const t of threads) {
    const lastAt = t.lastMessageAt ?? new Date(0);
    items.push({
      chunk_id: t.id,
      object_type: "thread",
      object_id: t.id,
      chunk_text: `thread channel=${t.channel} subject=${t.subject ?? "(no subject)"} last_message_at=${lastAt.toISOString()}`,
      source_ref: `thread ${t.id}`,
      source_type: "summary",
      occurred_at: lastAt,
      freshness_hours: Math.max(0, (now - lastAt.getTime()) / 3_600_000),
      confidence_score: 0.7,
      corroborated_by_count: 0,
      permission_scope: "workspace",
      raw_event_ref: null,
      summary_version: 0,
    });
  }
  for (const lead of leads) {
    items.push({
      chunk_id: lead.id,
      object_type: "lead",
      object_id: lead.id,
      chunk_text: `lead status=${lead.status} last_updated=${lead.updatedAt.toISOString()}`,
      source_ref: `lead ${lead.id}`,
      source_type: "summary",
      occurred_at: lead.updatedAt,
      freshness_hours: Math.max(0, (now - lead.updatedAt.getTime()) / 3_600_000),
      confidence_score: 0.8,
      corroborated_by_count: 0,
      permission_scope: "workspace",
      raw_event_ref: null,
      summary_version: 0,
    });
  }

  return { summaries: [], items, estimated_tokens: items.length * 30 };
}
