/**
 * USD-per-million-tokens price for each pinned model. Pricing is pinned to an
 * exact model version because providers roll out price changes silently.
 * Update this table whenever a model is adopted or pricing changes.
 */
export const pricing = {
  anthropic: {
    "claude-sonnet-4-20250514": {
      /** USD per 1M input tokens. */
      inputUsdPerMillion: 3,
      /** USD per 1M output tokens. */
      outputUsdPerMillion: 15,
    },
  },
  openai: {
    "text-embedding-3-small": {
      inputUsdPerMillion: 0.02,
    },
  },
  /** Realtime audio (gpt-4o-realtime-preview) — metered per audio token. */
  openaiRealtime: {
    "gpt-4o-realtime-preview-2024-12-17": {
      /** USD per 1M audio input tokens. */
      audioInputUsdPerMillion: 100,
      /** USD per 1M audio output tokens. */
      audioOutputUsdPerMillion: 200,
      /** USD per 1M text input tokens (realtime tool calls / system). */
      textInputUsdPerMillion: 5,
      /** USD per 1M text output tokens. */
      textOutputUsdPerMillion: 20,
    },
  },
  /** Provider-metered side effects. USD per message / minute / segment. */
  resend: {
    /** Transactional email cost per message. Resend's Pro plan bills
     *  $0.0004 per email (2024) — pin here so ledger writes don't need
     *  to chase the provider's price page. */
    perMessageUsd: 0.0004,
  },
} as const;

/**
 * Convert a token count and a per-1M-token USD price into integer USD micros.
 * Micros are used throughout the ledger to avoid float drift.
 *   tokens * (usd / 1_000_000_tokens) * 1_000_000_micros_per_usd
 *     simplifies to tokens * usdPerMillion.
 */
export function tokensToUsdMicros(tokens: number, usdPerMillion: number): number {
  return Math.round(tokens * usdPerMillion);
}
