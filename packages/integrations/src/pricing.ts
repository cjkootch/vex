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
