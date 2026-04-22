import {
  TenantId,
  type EvidenceItem,
  type EvidencePack,
} from "@vex/domain";
import { EMAIL_REPLY_DRAFT_SYSTEM_PROMPT } from "../prompts/email-reply-draft.js";
import type { ProposedAction } from "@vex/integrations";
import type { AgentContext, AgentOutput, IAgent } from "./types.js";

export interface EmailReplyDraftAgentInput {
  /** The inbound email touchpoint to reply to. */
  touchpointId: string;
}

const THREAD_LOOKBACK_DAYS = 14;
const MAX_THREAD_MESSAGES = 8;
const MAX_BODY_CHARS = 4000;

/**
 * T1 agent. Drafts a reply to a specific inbound email touchpoint. The
 * draft lands as a pending `email.send` approval (T2) so the operator
 * reviews + edits before the runner dispatches through Resend. Never
 * sends on its own.
 *
 * Triggered after a successful inbound-email normalization — see the
 * hook in packages/integrations/src/normalizers/email-inbound.ts.
 */
export class EmailReplyDraftAgent implements IAgent {
  readonly name = "email_reply_draft";
  readonly tier = "T1" as const;

  constructor(private readonly input: EmailReplyDraftAgentInput) {}

  async run(ctx: AgentContext): Promise<AgentOutput> {
    const touchpoint = await ctx.touchpoints.findById(ctx.tx, this.input.touchpointId);
    if (!touchpoint) {
      return emptyOutput(`touchpoint ${this.input.touchpointId} not found`);
    }

    const meta = (touchpoint.metadata ?? {}) as Record<string, unknown>;
    const direction = typeof meta["direction"] === "string" ? meta["direction"] : null;
    const from = typeof meta["from"] === "string" ? meta["from"] : null;
    const subject =
      typeof meta["subject"] === "string" ? meta["subject"] : null;
    const bodyText =
      typeof meta["body_text"] === "string" ? meta["body_text"] : null;
    const messageId =
      typeof meta["message_id"] === "string" ? meta["message_id"] : null;

    if (direction !== "inbound" || !from) {
      return emptyOutput("touchpoint is not an inbound email");
    }
    if (!bodyText || bodyText.trim().length === 0) {
      return emptyOutput("inbound email has no body text to draft against");
    }

    const thread = touchpoint.contactId
      ? await ctx.touchpoints.listForContactSince(
          ctx.tx,
          touchpoint.contactId,
          new Date(Date.now() - THREAD_LOOKBACK_DAYS * 24 * 60 * 60 * 1000),
          MAX_THREAD_MESSAGES,
        )
      : [];

    const org = touchpoint.orgId
      ? await ctx.organizations.findById(ctx.tx, touchpoint.orgId)
      : null;

    const evidencePack = buildPack({
      touchpoint,
      bodyText,
      thread,
      orgName: org?.legalName ?? null,
    });

    const replySubject = subject
      ? subject.startsWith("Re:")
        ? subject
        : `Re: ${subject}`
      : "Re:";

    const result = await ctx.anthropic.query({
      tenantId: TenantId(ctx.tenantId),
      idempotencyKey: `email_reply_draft:${ctx.agentRunId}`,
      systemPrompt: EMAIL_REPLY_DRAFT_SYSTEM_PROMPT,
      evidencePack,
      userMessage:
        `Draft a reply to the inbound email from ${from}. ` +
        `Original subject: ${subject ?? "(none)"}. ` +
        `Use "${replySubject}" as the reply subject unless you have a strong reason to change it.`,
      maxTokens: 1200,
    });

    const suggestion = result.proposedActions.find(
      (a) => a.kind === "email_reply_draft.suggestion" && a.tier === "T1",
    );
    if (!suggestion) {
      return {
        costUsd: result.costUsd,
        outputRefs: {
          touchpoint_id: touchpoint.id,
          drafted: false,
          reason: "model returned no suggestion",
        },
        proposedActions: [] as ProposedAction[],
        internalWrites: 0,
        rationale: "no draft produced",
      };
    }

    const draftSubject = stringField(suggestion.payload, "subject") ?? replySubject;
    const draftBody = stringField(suggestion.payload, "body");
    if (!draftBody || draftBody.trim().length === 0) {
      return {
        costUsd: result.costUsd,
        outputRefs: {
          touchpoint_id: touchpoint.id,
          drafted: false,
          reason: "model returned empty body",
        },
        proposedActions: [] as ProposedAction[],
        internalWrites: 0,
        rationale: "empty draft body",
      };
    }

    const approval = await ctx.approvals.create(ctx.tx, ctx.tenantId, {
      agentRunId: ctx.agentRunId,
      actionType: "email.send",
      proposedPayload: {
        tier: "T2",
        to: [from],
        subject: draftSubject,
        body: draftBody,
        ...(messageId ? { inReplyTo: messageId } : {}),
        ...(touchpoint.contactId ? { contactId: touchpoint.contactId } : {}),
        source: "email_reply_draft",
        replied_to_touchpoint_id: touchpoint.id,
        rationale:
          suggestion.rationale ??
          "AI-drafted reply to inbound email — review before sending.",
      },
    });

    await ctx.events.insertIfNotExists(ctx.tx, ctx.tenantId, {
      verb: "agent.email_reply_draft.draft_created",
      subjectType: "approval",
      subjectId: approval.id,
      actorType: "system",
      actorId: "email_reply_draft",
      objectType: "touchpoint",
      objectId: touchpoint.id,
      occurredAt: new Date(),
      idempotencyKey: `email_reply_draft:${approval.id}`,
      metadata: {
        touchpoint_id: touchpoint.id,
        approval_id: approval.id,
        from,
        subject: draftSubject,
      },
    });

    return {
      costUsd: result.costUsd,
      outputRefs: {
        touchpoint_id: touchpoint.id,
        approval_id: approval.id,
        drafted: true,
      },
      proposedActions: [] as ProposedAction[],
      internalWrites: 1,
      rationale: `drafted reply to ${from} (approval ${approval.id})`,
    };
  }
}

function emptyOutput(reason: string): AgentOutput {
  return {
    costUsd: 0,
    outputRefs: { drafted: false, reason },
    proposedActions: [] as ProposedAction[],
    internalWrites: 0,
    rationale: reason,
  };
}

function stringField(
  md: Record<string, unknown>,
  key: string,
): string | null {
  const v = md[key];
  return typeof v === "string" ? v : null;
}

function buildPack(args: {
  touchpoint: {
    id: string;
    channel: string;
    occurredAt: Date;
    metadata: Record<string, unknown>;
  };
  bodyText: string;
  thread: {
    id: string;
    channel: string;
    occurredAt: Date;
    metadata: Record<string, unknown>;
  }[];
  orgName: string | null;
}): EvidencePack {
  const now = Date.now();
  const items: EvidenceItem[] = [];
  const truncated =
    args.bodyText.length > MAX_BODY_CHARS
      ? args.bodyText.slice(0, MAX_BODY_CHARS) + "\n…[truncated]"
      : args.bodyText;

  const meta = args.touchpoint.metadata;
  const from = typeof meta["from"] === "string" ? meta["from"] : "unknown";
  const subject =
    typeof meta["subject"] === "string" ? meta["subject"] : "(none)";

  items.push({
    chunk_id: `inbound:${args.touchpoint.id}`,
    object_type: "touchpoint",
    object_id: args.touchpoint.id,
    chunk_text: `INBOUND EMAIL — from=${from} subject=${subject}\n\n${truncated}`,
    source_ref: `touchpoint ${args.touchpoint.id}`,
    source_type: "event",
    occurred_at: args.touchpoint.occurredAt,
    freshness_hours: Math.max(
      0,
      (now - args.touchpoint.occurredAt.getTime()) / 3_600_000,
    ),
    confidence_score: 1,
    corroborated_by_count: 0,
    permission_scope: "workspace",
    raw_event_ref: null,
    summary_version: 0,
  });

  if (args.orgName) {
    items.push({
      chunk_id: `org:${args.touchpoint.id}`,
      object_type: "organization",
      object_id: args.touchpoint.id,
      chunk_text: `Counterparty: ${args.orgName}`,
      source_ref: "organization",
      source_type: "summary",
      occurred_at: args.touchpoint.occurredAt,
      freshness_hours: 0,
      confidence_score: 0.9,
      corroborated_by_count: 0,
      permission_scope: "workspace",
      raw_event_ref: null,
      summary_version: 0,
    });
  }

  for (const t of args.thread) {
    if (t.id === args.touchpoint.id) continue;
    const tMeta = t.metadata;
    const tDir = typeof tMeta["direction"] === "string" ? tMeta["direction"] : "?";
    const tSubj =
      typeof tMeta["subject"] === "string" ? tMeta["subject"] : null;
    const tPreview =
      (typeof tMeta["body_text"] === "string"
        ? tMeta["body_text"]
        : typeof tMeta["preview"] === "string"
          ? tMeta["preview"]
          : "") ?? "";
    const trimmed = tPreview.slice(0, 600);
    items.push({
      chunk_id: `thread:${t.id}`,
      object_type: "touchpoint",
      object_id: t.id,
      chunk_text: `${tDir.toUpperCase()} ${t.channel} ${tSubj ? `subject=${tSubj}` : ""}\n${trimmed}`,
      source_ref: `touchpoint ${t.id}`,
      source_type: "event",
      occurred_at: t.occurredAt,
      freshness_hours: Math.max(0, (now - t.occurredAt.getTime()) / 3_600_000),
      confidence_score: 0.8,
      corroborated_by_count: 0,
      permission_scope: "workspace",
      raw_event_ref: null,
      summary_version: 0,
    });
  }

  return {
    summaries: [],
    items,
    estimated_tokens: items.reduce(
      (acc, i) => acc + Math.ceil(i.chunk_text.length / 4),
      0,
    ),
  };
}
