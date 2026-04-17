import { TenantId, type EvidenceItem, type EvidencePack } from "@vex/domain";
import { validateManifest } from "@vex/ui";
import type { ProposedAction } from "@vex/integrations";
import { QUERY_SYSTEM_PROMPT } from "../prompts/query.js";
import { VoiceContextBuilder } from "../voice/context.js";
import type { AgentContext, AgentOutput, IAgent } from "./types.js";

export interface CallPrepAgentInput {
  /** The org the call is about. */
  organizationId: string;
  /** Optional primary contact. */
  contactId?: string;
}

/**
 * T2 agent. Produces a call-prep brief (profile + timeline + talking-points
 * table) and queues it as a T2 approval so a manager / the user must
 * acknowledge the brief before the product delivers it. This is a
 * deliberate product decision — call briefs are high-stakes and get
 * reviewed, not auto-delivered.
 *
 * Trigger: manual only (user clicks "Prepare for call"). Not scheduled.
 */
export class CallPrepAgent implements IAgent {
  readonly name = "call_prep";
  readonly tier = "T2" as const;

  constructor(private readonly input: CallPrepAgentInput) {}

  async run(ctx: AgentContext): Promise<AgentOutput> {
    const orgId = this.input.organizationId;
    const contactId = this.input.contactId ?? null;

    const builder = new VoiceContextBuilder({
      organizations: ctx.organizations,
      contacts: ctx.contacts,
      summaries: ctx.summaries,
      touchpoints: ctx.touchpoints,
      approvals: ctx.approvals,
    });

    const voiceContext = await builder.build(ctx.tx, { orgId, contactId });

    const evidencePack = buildPack(voiceContext);

    const result = await ctx.anthropic.query({
      tenantId: TenantId(ctx.tenantId),
      idempotencyKey: `call_prep:${ctx.agentRunId}`,
      systemPrompt: QUERY_SYSTEM_PROMPT,
      evidencePack,
      userMessage:
        `Prepare a call brief for organization ${orgId}${contactId ? ` / contact ${contactId}` : ""}. ` +
        `Include a profile panel, a timeline of the last touchpoints, and a short "Talking points" table. ` +
        `Keep it to three panels maximum.`,
      maxTokens: 1800,
    });

    const validation = validateManifest(result.viewManifest);
    const manifest = validation.success ? validation.manifest : validation.fallback;

    const action: ProposedAction = {
      kind: "call_brief.deliver",
      tier: "T2",
      payload: {
        org_id: orgId,
        contact_id: contactId,
        manifest,
        answer: result.answer,
        voice_context_tokens: voiceContext.totalEstimatedTokens,
      },
      rationale:
        "Call briefs are reviewed before delivery so sensitive or stale points can be removed.",
    };

    return {
      costUsd: result.costUsd,
      outputRefs: {
        org_id: orgId,
        contact_id: contactId,
        manifest_valid: validation.success,
        panels: manifest.panels.length,
        voice_context_tokens: voiceContext.totalEstimatedTokens,
      },
      proposedActions: [action],
      internalWrites: 0,
      rationale: `prep brief for ${orgId}`,
    };
  }
}

function buildPack(ctx: {
  orgSummary: { text: string; estimatedTokens: number } | null;
  recentCalls: { text: string; estimatedTokens: number }[];
  openFollowUps: { text: string; estimatedTokens: number }[];
  keyContacts: { text: string; estimatedTokens: number }[];
  recentEmailClicks: { text: string; estimatedTokens: number }[];
  totalEstimatedTokens: number;
  orgId: string | null;
}): EvidencePack {
  const now = new Date();
  const summaries: EvidenceItem[] = [];
  const items: EvidenceItem[] = [];
  const orgId = ctx.orgId ?? "unknown";

  if (ctx.orgSummary) {
    summaries.push({
      chunk_id: `voice_ctx:org_summary`,
      object_type: "organization",
      object_id: orgId,
      chunk_text: ctx.orgSummary.text,
      source_ref: "voice_context.org_summary",
      source_type: "summary",
      occurred_at: now,
      freshness_hours: 0,
      confidence_score: 0.85,
      corroborated_by_count: 0,
      permission_scope: "workspace",
      raw_event_ref: null,
      summary_version: null,
    });
  }

  const pushItem = (
    kind: string,
    i: number,
    text: string,
    confidence: number,
  ): void => {
    items.push({
      chunk_id: `voice_ctx:${kind}:${i}`,
      object_type: kind,
      object_id: orgId,
      chunk_text: text,
      source_ref: `voice_context.${kind}[${i}]`,
      source_type: "event",
      occurred_at: now,
      freshness_hours: 0,
      confidence_score: confidence,
      corroborated_by_count: 0,
      permission_scope: "workspace",
      raw_event_ref: null,
      summary_version: null,
    });
  };

  ctx.recentCalls.forEach((b, i) => pushItem("recent_call", i, b.text, 0.8));
  ctx.openFollowUps.forEach((b, i) => pushItem("open_follow_up", i, b.text, 0.75));
  ctx.keyContacts.forEach((b, i) => pushItem("key_contact", i, b.text, 0.7));
  ctx.recentEmailClicks.forEach((b, i) => pushItem("email_click", i, b.text, 0.5));

  return {
    summaries,
    items,
    estimated_tokens: ctx.totalEstimatedTokens,
  };
}
