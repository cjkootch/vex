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
 * Aggregate projections Vex can reference when the user asks
 * comparative or roll-up questions — "how many open deals",
 * "margin on Jet A-1 vs ULSD", "which counterparties show up the
 * most". These sit alongside per-row evidence items so the agent
 * doesn't have to re-derive totals from hand-hydrated lists.
 */
export interface EvidenceAggregates {
  /** Deal pipeline by status and product. */
  pipeline: {
    by_status: Array<{
      status: string;
      deal_count: number;
      total_volume_usg: number;
      total_revenue_usd: number;
    }>;
    by_product: Array<{
      product: string;
      deal_count: number;
      total_volume_usg: number;
      avg_margin_pct: number | null;
    }>;
    /**
     * Sprint V — split pipeline totals by line of business so the
     * chat agent can answer "how many fuel deals vs food deals",
     * "what's my food pipeline value", etc. without re-summing.
     */
    by_line_of_business: Array<{
      line_of_business: string;
      deal_count: number;
      total_volume_usg: number;
    }>;
    totals: {
      open_deal_count: number;
      closed_won_deal_count: number;
      compliance_hold_count: number;
    };
  };
  /** Open proactive signals grouped by severity and rule. */
  signals: {
    open_total: number;
    by_severity: Array<{ severity: string; count: number }>;
    by_rule: Array<{ rule_id: string; count: number }>;
  };
  /** Top counterparties by deal count in the last 90 days. */
  top_counterparties: Array<{
    org_id: string;
    name: string;
    deal_count: number;
    latest_deal_ref: string | null;
  }>;
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
  /** Optional aggregate projections (pipeline / signals / counterparties). */
  aggregates?: EvidenceAggregates;
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
