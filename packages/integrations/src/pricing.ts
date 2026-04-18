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
  /**
   * Twilio messaging. US tier-1 pricing as of 2024: SMS is billed per
   * 160-char segment; WhatsApp is billed per message with a business-
   * initiated vs user-initiated split.
   */
  twilio: {
    smsSegmentUsd: 0.0083,
    /** User-initiated (within the 24h session window). */
    whatsappSessionUsd: 0.005,
    /** Business-initiated — template required, priced per category. */
    whatsappBusinessInitiatedUsd: 0.03,
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
