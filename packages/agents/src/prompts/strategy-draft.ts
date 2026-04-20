import type { WorkspaceStrategy } from "@vex/db";

/**
 * Evidence snapshot the drafter uses to ground each slot. Kept small
 * on purpose — the drafter's job is to synthesise from what the
 * operator already has, not to pretend to know everything.
 */
export interface StrategyDraftEvidence {
  /** Rows in `organizations` grouped by kind. */
  org_counts: {
    buyer: number;
    supplier: number;
    broker: number;
    buyer_broker: number;
    internal: number;
    competitor: number;
  };
  /**
   * Top-N products traded in `fuel_deals` over the last 90 days,
   * highest volume first.
   */
  top_products: Array<{ product: string; deal_count: number }>;
  /** Open + in-flight deal count. */
  active_deal_count: number;
  /** Most recent `fuel_deals.destination_port` values, deduped, newest first. */
  recent_destinations: string[];
}

export type StrategySlot =
  | "mission"
  | "target_markets"
  | "icp_buyers"
  | "icp_suppliers"
  | "brand_voice"
  | "pricing_philosophy"
  | "no_go_zones"
  | "growth_priorities"
  | "additional_guidance";

const SLOT_TEXT_SCHEMA: Record<StrategySlot, { kind: "text" | "list"; guidance: string }> = {
  mission: {
    kind: "text",
    guidance: `A one-paragraph mission statement. Why this company exists and who it serves. 40-80 words. Peer-to-peer, not marketing copy.`,
  },
  target_markets: {
    kind: "list",
    guidance: `A list of regions / countries / corridors. 3-8 entries. Each entry is short — a place name, not a sentence. Use the evidence's top destinations as anchors.`,
  },
  icp_buyers: {
    kind: "text",
    guidance: `Describe the ideal buyer in 60-120 words. Size, geography, buying behaviour, payment posture. Ground it in the counterparty mix from evidence.`,
  },
  icp_suppliers: {
    kind: "text",
    guidance: `Describe the ideal supplier in 60-120 words. Capabilities, logistics, reliability signals, geography. Ground it in what the company already trades.`,
  },
  brand_voice: {
    kind: "text",
    guidance: `Describe in 50-100 words how Vex should sound on every email, draft, and proposal. Specific — reference tone, vocabulary, what to avoid. Peer-to-peer operator voice, not marketing-speak.`,
  },
  pricing_philosophy: {
    kind: "text",
    guidance: `50-100 words on margin floors, payment terms (LC vs open account vs prepay), basis-differential posture, and when the company will walk from a deal. Concrete rules, not platitudes.`,
  },
  no_go_zones: {
    kind: "list",
    guidance: `A list of entities / regions / deal shapes the company will never touch. 3-8 entries. Short — each entry is a phrase. Include OFAC-adjacent jurisdictions + any evidence-derived red flags.`,
  },
  growth_priorities: {
    kind: "list",
    guidance: `A list of specific, concrete goals for this quarter. 3-6 entries. Each is a short action-oriented sentence ("Land 3 new Caribbean rice buyers" not "expand rice"). Derive from evidence gaps + product mix.`,
  },
  additional_guidance: {
    kind: "text",
    guidance: `Any extra notes the company wants Vex to always apply. 50-200 words. Free-form. If there's nothing distinctive beyond the other slots, suggest two or three operator-helpful defaults.`,
  },
};

/**
 * Build the system prompt for the slot-drafting agent. Stable across
 * slots — the slot-specific guidance + schema come in the user
 * message.
 */
export const STRATEGY_DRAFT_SYSTEM_PROMPT = `You draft company-strategy content for a commodity trading / brokerage CRM. The operator has opened a "strategy" slot and asked for help filling it in.

RULES:
- Return ONLY a JSON object of the shape the slot requires. No prose, no markdown fences, no commentary.
  - "text" slots: { "draft": "<string>" }
  - "list" slots: { "draft": ["<string>", "<string>", ...] }
- Ground every statement in the evidence block provided. NEVER invent counterparties, products, or regions that aren't in the evidence.
- If the evidence is thin (e.g. active_deal_count === 0), produce a minimal, clearly-generic draft and note that in the text (e.g. "early stage — refine once more deals close").
- Mirror the tone of whatever the operator has already filled in other slots (under "existing_strategy"). If no other slots are filled, default to direct, peer-to-peer operator voice.
- Respect the word / entry budget in the slot guidance. Don't write a 300-word mission when the brief says 40-80.
- The operator's "hints" (if provided) override the evidence — treat them as requirements, not suggestions.`;

export function buildStrategyDraftUserMessage(
  slot: StrategySlot,
  evidence: StrategyDraftEvidence,
  existing: WorkspaceStrategy,
  hints: string | null,
): string {
  const spec = SLOT_TEXT_SCHEMA[slot];
  const parts: string[] = [];
  parts.push(`Slot: ${slot}`);
  parts.push(`Slot kind: ${spec.kind}`);
  parts.push(`Slot guidance: ${spec.guidance}`);
  parts.push("");
  parts.push("Evidence:");
  parts.push(JSON.stringify(evidence, null, 2));
  parts.push("");
  parts.push("Existing strategy (slots the operator has already written):");
  parts.push(JSON.stringify(stripMetaFields(existing), null, 2));
  if (hints && hints.trim().length > 0) {
    parts.push("");
    parts.push("Operator hints (treat as requirements):");
    parts.push(hints.trim());
  }
  parts.push("");
  parts.push(
    spec.kind === "list"
      ? `Return { "draft": ["<entry>", ...] }.`
      : `Return { "draft": "<text>" }.`,
  );
  return parts.join("\n");
}

export function slotKind(slot: StrategySlot): "text" | "list" {
  return SLOT_TEXT_SCHEMA[slot].kind;
}

/**
 * Parse the drafter's response. Returns a string for text slots or a
 * string[] for list slots. Rejects malformed JSON, wrong-type drafts,
 * and list entries that aren't non-empty strings.
 */
export function parseStrategyDraft(
  slot: StrategySlot,
  raw: string,
): { ok: true; draft: string | string[] } | { ok: false; reason: string } {
  const kind = slotKind(slot);
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start === -1 || end === -1 || end < start) {
    return { ok: false, reason: "no_json_object" };
  }
  let obj: unknown;
  try {
    obj = JSON.parse(raw.slice(start, end + 1));
  } catch {
    return { ok: false, reason: "invalid_json" };
  }
  if (!isRecord(obj)) return { ok: false, reason: "not_an_object" };
  const draft = obj["draft"];
  if (kind === "text") {
    if (typeof draft !== "string" || draft.trim().length === 0) {
      return { ok: false, reason: "expected_non_empty_string" };
    }
    return { ok: true, draft: draft.trim() };
  }
  if (!Array.isArray(draft)) return { ok: false, reason: "expected_array" };
  const cleaned: string[] = [];
  for (const entry of draft) {
    if (typeof entry !== "string") continue;
    const t = entry.trim();
    if (t.length > 0) cleaned.push(t);
  }
  if (cleaned.length === 0) {
    return { ok: false, reason: "empty_array" };
  }
  return { ok: true, draft: cleaned };
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function stripMetaFields(s: WorkspaceStrategy): WorkspaceStrategy {
  const { updated_at: _updatedAt, updated_by: _updatedBy, ...rest } = s;
  void _updatedAt;
  void _updatedBy;
  return rest;
}

export const STRATEGY_DRAFT_PROMPT_VERSION = "v1.2026-04-20";
