import { TenantId } from "@vex/domain";
import type { ProposedAction } from "@vex/integrations";
import type { AgentContext, AgentOutput, IAgent } from "./types.js";

/**
 * Either source the qualification pulls from. Chat reads the transcript
 * Document the website-chat normalizer stored on the contact. Form-fill
 * reads the most recent `web_form` touchpoint on the lead's contact —
 * the FormFillNormalizer writes `{country, product_interest, message,
 * sms_consent, phone, form_name}` into that touchpoint's metadata.
 */
export type LeadQualificationInput =
  | { source: "website_chat"; conversationId: string }
  | { source: "website_form"; leadId: string };

/**
 * Pulls a compact qualification JSON from a newly-landed lead:
 *   `{product, volume, destination, timeline, urgency, buying_intent,
 *   summary}`.
 *
 * Writes the result to `leads.qualification_summary` as a stringified
 * JSON blob so downstream workflows (follow-up queueing, deal creation)
 * can read structured fields without re-running the LLM.
 *
 * T1 internal-write only — no proposed actions. The deal-creation
 * nibble that comes later will propose `crm.create_deal` as a T2
 * approval when buying_intent >= "intent_to_buy".
 *
 * Two flavours of input:
 *   - `website_chat` — reads the transcript document. Rich signal.
 *   - `website_form` — reads the form touchpoint metadata. Thinner
 *     signal (one message + product_interest + country) but still
 *     structured enough to produce a useful qualification.
 */
export class LeadQualificationAgent implements IAgent {
  readonly name = "lead_qualification";
  readonly tier = "T1" as const;

  constructor(private readonly input: LeadQualificationInput) {}

  async run(ctx: AgentContext): Promise<AgentOutput> {
    const lead = await this.resolveLead(ctx);
    if (!lead) {
      return skip(
        "lead_not_found",
        this.input.source === "website_chat"
          ? `no lead for conversation ${this.input.conversationId}`
          : `no lead with id ${this.input.leadId}`,
      );
    }
    if (!lead.contactId) {
      return skip("lead_missing_contact", `lead ${lead.id} has no contactId`);
    }

    const content = await this.loadContent(ctx, lead.contactId);
    if (!content) {
      return skip(
        this.input.source === "website_chat"
          ? "no_transcript_document"
          : "no_form_touchpoint",
        this.input.source === "website_chat"
          ? `lead ${lead.id} has no chat_transcript document`
          : `lead ${lead.id} has no web_form touchpoint`,
      );
    }

    const result = await ctx.anthropic.complete({
      tenantId: TenantId(ctx.tenantId),
      idempotencyKey: `lead_qualification:${ctx.agentRunId}`,
      system: SYSTEM_PROMPT,
      maxTokens: 600,
      messages: [{ role: "user", content: content.userMessage }],
    });

    const raw = result.content
      .filter((b): b is { type: "text"; text: string } => b.type === "text")
      .map((b) => b.text)
      .join("")
      .trim();

    const parsed = parseQualificationJson(raw);
    if (!parsed) {
      return {
        costUsd: 0,
        outputRefs: { skipped: "parse_failure", raw },
        proposedActions: [],
        internalWrites: 0,
        rationale: `lead ${lead.id}: Claude returned non-JSON output`,
      };
    }

    await ctx.leads.updateQualification(ctx.tx, lead.id, JSON.stringify(parsed));

    // Sprint S.2 — when the qualification surfaces buying intent or
    // time urgency, emit a distinct `lead.hot` event so the Brief
    // page + signals feed can surface it loudly. We don't use the
    // same idempotency key space as the qualification write — an
    // operator re-running the agent after the first hot signal
    // already fired shouldn't double-count, but a genuinely fresh
    // agent_run should land its own event (so trends stay visible).
    const isHot = isHotSignal(parsed);
    if (isHot) {
      await ctx.events.insertIfNotExists(ctx.tx, ctx.tenantId, {
        verb: "lead.hot",
        subjectType: "lead",
        subjectId: lead.id,
        actorType: "system",
        actorId: "lead_qualification",
        objectType: "contact",
        objectId: lead.contactId,
        occurredAt: new Date(),
        idempotencyKey: `lead.hot:${lead.id}:${ctx.agentRunId}`,
        metadata: {
          source: this.input.source,
          buying_intent: parsed["buying_intent"] ?? null,
          urgency: parsed["urgency"] ?? null,
          product: parsed["product"] ?? null,
          volume: parsed["volume"] ?? null,
          destination: parsed["destination"] ?? null,
          timeline: parsed["timeline"] ?? null,
          summary: parsed["summary"] ?? null,
        },
      });
    }

    // Sprint T.1 — autonomy leap. On hot leads where Claude produced a
    // usable draft_reply AND the contact has an email on file, emit a
    // T2 email.send proposed action. AgentRunner routes it through
    // ApprovalGate so it lands as a pending approval in /app/approvals.
    // Operator reviews + approves; applyEmailSend fires the Resend
    // post-commit. Lead arrives → draft already waiting for review.
    const proposedActions: ProposedAction[] = [];
    const draftReply = isHot ? extractDraftReply(parsed) : null;
    const contact = lead.contactId
      ? await ctx.contacts.findById(ctx.tx, lead.contactId)
      : null;
    const contactEmail = contact?.emails?.[0] ?? null;
    if (draftReply && contactEmail) {
      proposedActions.push({
        kind: "email.send",
        tier: "T2",
        payload: {
          to: [contactEmail],
          subject: draftReply.subject,
          body: draftReply.body,
          contact_id: lead.contactId,
          lead_id: lead.id,
          source: this.input.source,
          auto_drafted_from: "lead_qualification",
        },
        rationale: `Auto-drafted reply on hot lead (${parsed["buying_intent"] ?? "?"} / ${parsed["urgency"] ?? "?"}). Operator review gate before send.`,
      });
    }

    return {
      costUsd: 0,
      outputRefs: {
        lead_id: lead.id,
        contact_id: lead.contactId,
        source: this.input.source,
        ...(content.sourceObjectId ? { source_object_id: content.sourceObjectId } : {}),
        qualification: parsed,
        hot: isHot,
        draft_proposed: Boolean(draftReply && contactEmail),
        draft_skip_reason: buildDraftSkipReason(isHot, draftReply, contactEmail),
      },
      proposedActions,
      internalWrites: isHot ? 2 : 1,
      rationale: `qualified lead ${lead.id} from ${this.input.source}${isHot ? " (hot)" : ""}${proposedActions.length > 0 ? " + auto-draft" : ""}`,
    };
  }

  private async resolveLead(ctx: AgentContext) {
    if (this.input.source === "website_chat") {
      return ctx.leads.findByExternalKey(
        ctx.tx,
        "website_chat.conversation_id",
        this.input.conversationId,
      );
    }
    return ctx.leads.findById(ctx.tx, this.input.leadId);
  }

  private async loadContent(
    ctx: AgentContext,
    contactId: string,
  ): Promise<{ userMessage: string; sourceObjectId?: string } | null> {
    if (this.input.source === "website_chat") {
      const docs = await ctx.documents.listBySubject(ctx.tx, "contact", contactId, 20);
      const transcript = docs.find(
        (d) => d.documentType === "chat_transcript" && d.extractedText,
      );
      if (!transcript || !transcript.extractedText) return null;
      return {
        userMessage: `Website-chat transcript:\n\n${transcript.extractedText.slice(0, 8000)}`,
        sourceObjectId: transcript.id,
      };
    }
    // website_form: scan the last year of touchpoints on the contact,
    // take the newest web_form hit. A contact with many form submissions
    // gets qualified against the most recent one.
    const oneYearAgo = new Date(Date.now() - 365 * 24 * 60 * 60 * 1000);
    const rows = await ctx.touchpoints.listForContactSince(
      ctx.tx,
      contactId,
      oneYearAgo,
      200,
    );
    const latest = rows.find((t) => t.channel === "web_form");
    if (!latest) return null;
    return {
      userMessage: renderFormSubmission(latest.metadata),
      sourceObjectId: latest.id,
    };
  }
}

function skip(reason: string, rationale: string): AgentOutput {
  return {
    costUsd: 0,
    outputRefs: { skipped: reason },
    proposedActions: [],
    internalWrites: 0,
    rationale,
  };
}

/**
 * Build the user-message body from a `web_form` touchpoint's metadata.
 * The shape matches what `FormFillNormalizer` writes:
 *   form_id, form_name, country, product_interest, message, sms_consent,
 *   phone, page_url, referrer, utm
 */
function renderFormSubmission(metadata: Record<string, unknown> | null): string {
  const md = (metadata ?? {}) as Record<string, unknown>;
  const rows: string[] = ["Lead form submission:"];
  const push = (label: string, key: string) => {
    const v = md[key];
    if (v === undefined || v === null || v === "") return;
    rows.push(`${label}: ${typeof v === "string" ? v : JSON.stringify(v)}`);
  };
  push("Form", "form_name");
  push("Country", "country");
  push("Product interest", "product_interest");
  push("Phone", "phone");
  push("SMS opt-in", "sms_consent");
  push("Message", "message");
  return rows.join("\n");
}

const SYSTEM_PROMPT = `You extract lead-qualification fields from an inbound website lead for Vector Trade Capital, a commodity trader (fuel + food). The lead arrives as either a website-chat transcript or a "Request a Quote" form submission. Apply the same schema to both.

Return ONLY a JSON object of this exact shape — no prose:

{
  "product": "rice" | "sugar" | "flour" | "oil" | "legumes" | "poultry" | "pork" | "ulsd" | "gasoline" | "jet" | "lpg" | "hfo" | "mgo" | null,
  "volume": "<string, e.g. 200kMT monthly or null>",
  "destination": "<string, port/country or null>",
  "timeline": "<string, e.g. Q3 2026 or null>",
  "urgency": "immediate" | "near_term" | "exploratory" | "unknown",
  "buying_intent": "intent_to_buy" | "qualifying" | "exploring" | "not_interested",
  "summary": "<one-sentence human summary for the operator>",
  "draft_reply": {
    "subject": "<string, <= 80 chars>",
    "body": "<string, 80-160 words>"
  } | null
}

Rules:
- Null out fields you can't support from the content. Never guess.
- For form submissions the "Product interest" field maps roughly to product: food → null (ambiguous, needs the message), fuel → null (same), vehicles/multiple → null. Only fill "product" if the message names a specific SKU.
- "immediate" means the visitor wants a quote now; "near_term" = weeks; "exploratory" = months/unclear.
- "intent_to_buy" requires explicit buying language ("need", "want to order", "what's your price on"). "qualifying" = asking specifics about delivery/terms. "exploring" = general info questions.
- summary MUST be one sentence, ≤140 chars, written for a busy trade-desk operator.
- draft_reply INSTRUCTIONS:
  - Include ONLY when buying_intent === "intent_to_buy" OR urgency === "immediate". Otherwise use null.
  - Write it as VTC replying TO the lead — address them by name, acknowledge their specific ask, propose a concrete next step.
  - Next step = "20-minute call this week" OR "send a spec sheet" OR "confirm current laycan availability", pick the one that matches the thread. ONE ask per email.
  - Tone: peer-to-peer trader voice. Direct. Numeric. No "I hope this finds you well", no "just touching base". Apply the brand-voice preamble above if provided.
  - Do NOT invent prices, laycan dates, or contract terms that weren't in the inbound.
  - Body is plain text, paragraphs separated by blank lines. No greeting/sign-off — Resend template handles those.`;

/**
 * A qualification is "hot" when either signal trips: explicit buying
 * language ("intent_to_buy") OR near-term timeline ("immediate").
 * Everything else — qualifying, exploring, near_term, exploratory —
 * stays warm and lands in the regular qualification feed without
 * firing a loud signal.
 */
export function isHotSignal(parsed: Record<string, unknown>): boolean {
  return (
    parsed["buying_intent"] === "intent_to_buy" ||
    parsed["urgency"] === "immediate"
  );
}

/**
 * Pull Claude's optional draft_reply out of the parsed payload and
 * validate it's a usable email. Rejects anything shorter than 20 chars
 * of body or 3 chars of subject — those are Claude fumbling the
 * shape, not something the operator wants to review. Returns null on
 * any validation failure so the agent just skips the auto-draft.
 */
export function extractDraftReply(
  parsed: Record<string, unknown>,
): { subject: string; body: string } | null {
  const raw = parsed["draft_reply"];
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const obj = raw as Record<string, unknown>;
  const subject = obj["subject"];
  const body = obj["body"];
  if (typeof subject !== "string" || typeof body !== "string") return null;
  const s = subject.trim();
  const b = body.trim();
  if (s.length < 3 || s.length > 200) return null;
  if (b.length < 20 || b.length > 4000) return null;
  return { subject: s, body: b };
}

function buildDraftSkipReason(
  isHot: boolean,
  draft: { subject: string; body: string } | null,
  email: string | null,
): string | null {
  if (!isHot) return "not_hot";
  if (!draft) return "no_draft_reply";
  if (!email) return "no_contact_email";
  return null;
}

function parseQualificationJson(raw: string): Record<string, unknown> | null {
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start === -1 || end === -1 || end < start) return null;
  try {
    const obj = JSON.parse(raw.slice(start, end + 1)) as Record<string, unknown>;
    // Minimal shape check so a malformed response doesn't silently land
    // garbage in qualification_summary.
    if (typeof obj["summary"] !== "string") return null;
    return obj;
  } catch {
    return null;
  }
}
