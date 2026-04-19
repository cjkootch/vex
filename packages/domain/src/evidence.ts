/**
 * Evidence is the typed projection of a retrieval result handed to the model.
 * The model never sees raw DB rows — only `EvidencePack`. This is the
 * boundary that enforces "no raw provider payloads in domain types".
 */

export interface EvidenceItem {
  /** ULID of the underlying embedding_chunks row. */
  chunk_id: string;
  /** e.g. "organization", "contact", "campaign", "summary". */
  object_type: string;
  object_id: string;
  /** The text the model will read. Already truncated to a reasonable size. */
  chunk_text: string;
  /** Human-readable origin marker (e.g. "summary v3 / Acme org profile"). */
  source_ref: string;
  /** "summary" | "event" | "document" | "message" — coarse category. */
  source_type: string;
  /** When the underlying fact actually happened, if known. */
  occurred_at: Date | null;
  /** Hours since `occurred_at` (or `created_at` fallback). */
  freshness_hours: number;
  /** 0..1; comes from field_confidence on summaries / explicit confidence on touchpoints. */
  confidence_score: number;
  /** How many other evidence items in the pack reference the same `(object_type, object_id)`. */
  corroborated_by_count: number;
  /** "workspace" | "shared_with_role" — RLS still enforces but agents respect this. */
  permission_scope: string;
  /** ULID of the raw_event row that produced this, if any. */
  raw_event_ref: string | null;
  /** Summary version when source_type === "summary". */
  summary_version: number | null;
}

/**
 * Concise descriptor for an existing campaign plan. Fed to the chat
 * agent in the evidence pack's "Campaigns catalog" section so it can
 * propose `campaign.enroll_batch` actions against real campaigns
 * (never invent campaign ids).
 */
export interface EvidenceCampaign {
  id: string;
  name: string;
  /** Channels present in the plan: e.g. ["email", "sms"]. */
  channels: string[];
  /** Total step count in the plan. */
  step_count: number;
  /** Most common tier across the steps — T1 / T2 / T3. */
  tier?: string;
}

/**
 * Bundle of evidence for one query: a few high-level summaries + many
 * chunk-level items. The pack respects a token budget (28k by default).
 */
export interface EvidencePack {
  items: EvidenceItem[];
  summaries: EvidenceItem[];
  /** Existing campaigns the agent can enroll contacts into. */
  campaigns?: EvidenceCampaign[];
  estimated_tokens: number;
}

/**
 * Approximate token count for a string. Anthropic's tokenizer averages
 * ~4 characters per token for English; this is the canonical heuristic
 * for budgeting before a real tokenizer is available.
 */
export function approxTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/** Sum the approximate tokens across an evidence pack. */
export function packTokens(pack: { items: EvidenceItem[]; summaries: EvidenceItem[] }): number {
  let total = 0;
  for (const item of pack.summaries) total += approxTokens(item.chunk_text);
  for (const item of pack.items) total += approxTokens(item.chunk_text);
  return total;
}
