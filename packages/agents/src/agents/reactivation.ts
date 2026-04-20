import { TenantId } from "@vex/domain";
import type { AgentContext, AgentOutput, IAgent } from "./types.js";

/**
 * Batch-draft reactivation emails for a named list of contacts.
 *
 * Triggered by an approved `lead.reactivate_draft` action. For each
 * contact id:
 *   1. Load contact + org + recent touchpoints for context.
 *   2. Ask Claude Haiku to draft a short, personalised re-engagement
 *      email grounded in the shared product context + angle + the
 *      contact's own history.
 *   3. Create ONE pending `email.send` approval per contact so the
 *      operator reviews each draft individually before it leaves the
 *      building. Every approval is T2 — drafts never auto-send.
 *
 * The agent never fans out email sends itself; it only proposes. The
 * batch is the multi-step part: one chat command → N approvals for
 * one review loop, instead of N round-trips to hand-write copy.
 */
export interface ReactivationBatchInput {
  contactIds: string[];
  productContext: string;
  angle?: string;
  parentApprovalId?: string;
  rationale?: string;
}

interface DraftResult {
  contactId: string;
  approvalId: string;
  email: string;
  subject: string;
}

interface SkipResult {
  contactId: string;
  reason: string;
}

export class ReactivationBatchAgent implements IAgent {
  readonly name = "reactivation_batch";
  readonly tier = "T1" as const; // agent internals are T1 — emitted approvals are T2

  constructor(private readonly input: ReactivationBatchInput) {}

  async run(ctx: AgentContext): Promise<AgentOutput> {
    const drafts: DraftResult[] = [];
    const skipped: SkipResult[] = [];

    for (const contactId of this.input.contactIds) {
      const outcome = await this.draftOne(ctx, contactId);
      if (outcome.kind === "drafted") {
        drafts.push(outcome.draft);
      } else {
        skipped.push({ contactId, reason: outcome.reason });
      }
    }

    await ctx.events.insertIfNotExists(ctx.tx, ctx.tenantId, {
      verb: "agent.reactivation.drafts_created",
      subjectType: "agent_run",
      subjectId: ctx.agentRunId,
      actorType: "system",
      actorId: "reactivation_batch",
      objectType: "agent_run",
      objectId: ctx.agentRunId,
      occurredAt: new Date(),
      idempotencyKey: `reactivation.drafts_created:${ctx.agentRunId}`,
      metadata: {
        parent_approval_id: this.input.parentApprovalId ?? null,
        drafted_count: drafts.length,
        skipped_count: skipped.length,
        drafts: drafts.map((d) => ({
          contact_id: d.contactId,
          approval_id: d.approvalId,
          subject: d.subject,
        })),
        skipped: skipped,
      },
    });

    return {
      // complete() records cost to the ledger on every call — surfacing
      // it here would double-count. Leave the agent-level cost at 0
      // and let the ledger be the source of truth for reconciliation.
      costUsd: 0,
      outputRefs: {
        drafted_count: drafts.length,
        skipped_count: skipped.length,
        draft_approvals: drafts.map((d) => d.approvalId),
      },
      proposedActions: [],
      internalWrites: drafts.length + 1, // N approvals + 1 audit event
      rationale: `drafted ${drafts.length}/${this.input.contactIds.length} reactivation emails`,
    };
  }

  private async draftOne(
    ctx: AgentContext,
    contactId: string,
  ): Promise<
    | { kind: "drafted"; draft: DraftResult }
    | { kind: "skipped"; reason: string }
  > {
    const contact = await ctx.contacts.findById(ctx.tx, contactId);
    if (!contact) return { kind: "skipped", reason: "contact_not_found" };
    const email = (contact.emails ?? [])[0];
    if (!email) return { kind: "skipped", reason: "contact_no_email" };

    const org = contact.orgId
      ? await ctx.organizations.findById(ctx.tx, contact.orgId)
      : null;
    const since = new Date(Date.now() - 180 * 24 * 60 * 60 * 1000);
    const recent = await ctx.touchpoints.listForContactSince(ctx.tx, contactId, since, 20);

    const result = await ctx.anthropic.complete({
      tenantId: TenantId(ctx.tenantId),
      idempotencyKey: `reactivation.draft:${ctx.agentRunId}:${contactId}`,
      system: SYSTEM_PROMPT,
      maxTokens: 600,
      messages: [
        {
          role: "user",
          content: buildUserMessage({
            contactName: contact.fullName,
            contactTitle: contact.title ?? null,
            orgName: org?.legalName ?? null,
            productContext: this.input.productContext,
            angle: this.input.angle ?? null,
            recentChannels: recent.map((t) => t.channel).slice(0, 10),
            mostRecentTouchpointAt:
              recent[0]?.occurredAt?.toISOString() ?? null,
          }),
        },
      ],
    });

    const raw = result.content
      .filter((b): b is { type: "text"; text: string } => b.type === "text")
      .map((b) => b.text)
      .join("")
      .trim();

    const parsed = parseDraft(raw);
    if (!parsed) return { kind: "skipped", reason: "parse_failure" };

    const approval = await ctx.approvals.create(ctx.tx, ctx.tenantId, {
      agentRunId: ctx.agentRunId,
      actionType: "email.send",
      proposedPayload: {
        tier: "T2",
        to: [email],
        subject: parsed.subject,
        body: parsed.body,
        contact_id: contactId,
        reactivation_batch: {
          parent_approval_id: this.input.parentApprovalId ?? null,
          product_context: this.input.productContext,
          angle: this.input.angle ?? null,
        },
      },
    });

    return {
      kind: "drafted",
      draft: {
        contactId,
        approvalId: approval.id,
        email,
        subject: parsed.subject,
      },
    };
  }
}

const SYSTEM_PROMPT = `You draft short, warm reactivation emails for Vector Trade Capital, a commodity trader (fuel + food). VTC is reaching out to someone they've transacted with or negotiated with before, to put a new offer or reason-to-talk in front of them.

Return ONLY a JSON object of this exact shape — no prose:

{
  "subject": "<string, <= 80 chars, no clickbait>",
  "body": "<string, 80-180 words, plain text, no signature>"
}

Rules:
- Tone: warm-professional, peer-to-peer. Not marketing-y.
- Personalise when you have signal: name the org, reference the product they're buying, acknowledge the gap since last contact if it's long.
- Make ONE clear ask: "open to a quick call next week?" or "worth sending you the spec?". Not both.
- Do NOT invent prices, volumes, or deal specifics unless given in the context. If you don't have specifics, keep it high-level.
- No "I hope this email finds you well". No "just checking in". No "wanted to touch base". Start with substance.
- No signature — the Resend template handles that.
- Body uses plain paragraphs separated by one blank line. No bullet points unless essential. No markdown.`;

interface DraftContext {
  contactName: string;
  contactTitle: string | null;
  orgName: string | null;
  productContext: string;
  angle: string | null;
  recentChannels: string[];
  mostRecentTouchpointAt: string | null;
}

function buildUserMessage(d: DraftContext): string {
  const lines: string[] = [];
  lines.push(`Recipient: ${d.contactName}${d.contactTitle ? `, ${d.contactTitle}` : ""}`);
  if (d.orgName) lines.push(`Organization: ${d.orgName}`);
  lines.push(`Product context: ${d.productContext}`);
  if (d.angle) lines.push(`Angle / reason we're reaching out: ${d.angle}`);
  lines.push(`Most recent touchpoint: ${d.mostRecentTouchpointAt ?? "none on file"}`);
  if (d.recentChannels.length > 0) {
    lines.push(`Recent channels: ${d.recentChannels.join(", ")}`);
  }
  lines.push("");
  lines.push("Draft one reactivation email per the rules.");
  return lines.join("\n");
}

function parseDraft(raw: string): { subject: string; body: string } | null {
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start === -1 || end === -1 || end < start) return null;
  try {
    const obj = JSON.parse(raw.slice(start, end + 1)) as Record<string, unknown>;
    if (typeof obj["subject"] !== "string" || typeof obj["body"] !== "string") return null;
    if (obj["subject"].length === 0 || obj["body"].length === 0) return null;
    return { subject: obj["subject"], body: obj["body"] };
  } catch {
    return null;
  }
}
