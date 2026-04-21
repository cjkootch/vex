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
   * Third-party per-unit pricing. USD per unit (not per 1M). Used by
   * integrations that meter per message / minute / call / search
   * rather than per-token. Figures are defaults — rates vary by
   * destination + contract tier, update when billing reconciles.
   */
  resend: {
    /** Paid Resend tier: $0.40 per 1k emails. */
    emailSendUsd: 0.0004,
  },
  twilio: {
    /** Outbound US SMS segment. */
    smsSegmentUsd: 0.0083,
    /** Business-initiated WhatsApp conversation (US). */
    whatsappSessionUsd: 0.005,
    /** Outbound PSTN dial to US numbers — per-minute average. */
    voiceMinuteUsd: 0.014,
  },
  tavily: {
    /** Basic search ≈ 1 credit; default plan ≈ $0.0045/credit. */
    searchBasicUsd: 0.0045,
    /** Advanced search ≈ 2 credits. */
    searchAdvancedUsd: 0.009,
  },
} as const;

/**
 * Convert a per-unit USD price + count into integer USD micros.
 * Used for non-token providers (Resend, Twilio, Tavily) where the
 * billable unit is a message, minute, or search rather than a token.
 */
export function unitsToUsdMicros(count: number, usdPerUnit: number): number {
  return Math.round(count * usdPerUnit * 1_000_000);
}

/**
 * Convert a token count and a per-1M-token USD price into integer USD micros.
 * Micros are used throughout the ledger to avoid float drift.
 *   tokens * (usd / 1_000_000_tokens) * 1_000_000_micros_per_usd
 *     simplifies to tokens * usdPerMillion.
 */
export function tokensToUsdMicros(tokens: number, usdPerMillion: number): number {
  return Math.round(tokens * usdPerMillion);
}
