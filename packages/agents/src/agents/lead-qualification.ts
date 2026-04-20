import { TenantId } from "@vex/domain";
import type { AgentContext, AgentOutput, IAgent } from "./types.js";

export interface LeadQualificationInput {
  /** Website-chat conversation id the normalizer stored in leads.externalKeys. */
  conversationId: string;
}

/**
 * Reads the transcript Document the website-chat normalizer stored on
 * the contact and asks Claude Haiku for a compact qualification JSON:
 * `{product, volume, destination, timeline, urgency, buying_intent,
 * summary}`. Writes the result to `leads.qualification_summary` as a
 * stringified JSON blob so downstream workflows (follow-up queueing,
 * deal creation) can read structured fields without re-running the
 * LLM.
 *
 * T1 internal-write only — no proposed actions. The deal-creation
 * nibble that comes later will propose `crm.create_deal` as a T2
 * approval when buying_intent >= "intent_to_buy".
 */
export class LeadQualificationAgent implements IAgent {
  readonly name = "lead_qualification";
  readonly tier = "T1" as const;

  constructor(private readonly input: LeadQualificationInput) {}

  async run(ctx: AgentContext): Promise<AgentOutput> {
    const lead = await ctx.leads.findByExternalKey(
      ctx.tx,
      "website_chat.conversation_id",
      this.input.conversationId,
    );
    if (!lead) {
      return {
        costUsd: 0,
        outputRefs: { skipped: "lead_not_found" },
        proposedActions: [],
        internalWrites: 0,
        rationale: `no lead for conversation ${this.input.conversationId}`,
      };
    }
    if (!lead.contactId) {
      return {
        costUsd: 0,
        outputRefs: { skipped: "lead_missing_contact" },
        proposedActions: [],
        internalWrites: 0,
        rationale: `lead ${lead.id} has no contactId`,
      };
    }

    const allDocs = await ctx.documents.listBySubject(
      ctx.tx,
      "contact",
      lead.contactId,
      20,
    );
    const transcript = allDocs.find(
      (d) => d.documentType === "chat_transcript" && d.extractedText,
    );
    if (!transcript || !transcript.extractedText) {
      return {
        costUsd: 0,
        outputRefs: { skipped: "no_transcript_document" },
        proposedActions: [],
        internalWrites: 0,
        rationale: `lead ${lead.id} has no chat_transcript document`,
      };
    }

    const result = await ctx.anthropic.complete({
      tenantId: TenantId(ctx.tenantId),
      idempotencyKey: `lead_qualification:${ctx.agentRunId}`,
      system: SYSTEM_PROMPT,
      maxTokens: 600,
      messages: [
        { role: "user", content: buildUserMessage(transcript.extractedText) },
      ],
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

    return {
      costUsd: 0,
      outputRefs: {
        lead_id: lead.id,
        document_id: transcript.id,
        qualification: parsed,
      },
      proposedActions: [],
      internalWrites: 1,
      rationale: `qualified lead ${lead.id} from conversation ${this.input.conversationId}`,
    };
  }
}

const SYSTEM_PROMPT = `You extract lead-qualification fields from a website-chat transcript for Vector Trade Capital, a commodity trader (fuel + food).

Return ONLY a JSON object of this exact shape — no prose:

{
  "product": "rice" | "sugar" | "flour" | "oil" | "legumes" | "poultry" | "pork" | "ulsd" | "gasoline" | "jet" | "lpg" | "hfo" | "mgo" | null,
  "volume": "<string, e.g. 200kMT monthly or null>",
  "destination": "<string, port/country or null>",
  "timeline": "<string, e.g. Q3 2026 or null>",
  "urgency": "immediate" | "near_term" | "exploratory" | "unknown",
  "buying_intent": "intent_to_buy" | "qualifying" | "exploring" | "not_interested",
  "summary": "<one-sentence human summary for the operator>"
}

Rules:
- Null out fields you can't support from the transcript. Never guess.
- "immediate" means the visitor wants a quote now; "near_term" = weeks; "exploratory" = months/unclear.
- "intent_to_buy" requires explicit buying language ("need", "want to order", "what's your price on"). "qualifying" = asking specifics about delivery/terms. "exploring" = general info questions.
- summary MUST be one sentence, ≤140 chars, written for a busy trade-desk operator.`;

function buildUserMessage(transcript: string): string {
  return `Transcript:\n\n${transcript.slice(0, 8000)}`;
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
