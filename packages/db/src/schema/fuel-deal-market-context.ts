import {
  doublePrecision,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { fuelDeals } from "./fuel-deals.js";

/**
 * Procur-sourced market context for a fuel deal. Populated by
 * `DealMarketContextAgent` on the draft→live transition (or on
 * explicit operator-triggered re-evaluation). One row per deal —
 * idempotent on re-run via the unique index on (tenant_id, deal_id).
 *
 * Distinct from `fuel_market_rates` (operator-managed pricing
 * references). This table is empirically derived from procur's
 * `award_price_deltas` distribution:
 *   - z-score: how many σ's the offer is from the empirical mean
 *   - percentile: rank of the offer within the historical sample
 *   - verdict: discrete bucket usable in UI + agent prompts
 *
 * Tenant-scoped via the standard RLS policy (see migration).
 */
export const fuelDealMarketContext = pgTable(
  "fuel_deal_market_context",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id").notNull(),
    dealId: text("deal_id")
      .notNull()
      .references(() => fuelDeals.id, { onDelete: "cascade" }),

    /** Benchmark used to anchor the analysis (e.g. `nyh_ulsd`,
        `argus_diesel_carib`). */
    benchmarkCode: text("benchmark_code").notNull(),
    /** Spot price for the benchmark on `evaluation_date`. */
    benchmarkSpotUsd: doublePrecision("benchmark_spot_usd"),
    /** Spot adjusted for the buyer-country premium pattern. Distinct
        from the raw spot — Caribbean diesel typically prices at
        +25% over NY Harbor ULSD. */
    effectiveBenchmarkUsd: doublePrecision("effective_benchmark_usd"),

    /** Offer price minus the effective benchmark, in USD per unit. */
    offerDeltaUsd: doublePrecision("offer_delta_usd"),
    /** Offer delta as a percentage of the effective benchmark. */
    offerDeltaPct: doublePrecision("offer_delta_pct"),

    historicalMeanDeltaPct: doublePrecision("historical_mean_delta_pct"),
    historicalMedianDeltaPct: doublePrecision("historical_median_delta_pct"),
    historicalStddevDeltaPct: doublePrecision("historical_stddev_delta_pct"),
    historicalSampleSize: integer("historical_sample_size"),

    /** Z-score of this offer in the historical distribution. Positive
        means the offer is above typical premium (high), negative means
        aggressive (possibly distress sale). */
    zScore: doublePrecision("z_score"),
    /** Percentile rank, 0-100. */
    percentile: doublePrecision("percentile"),
    /** `aggressive` | `competitive` | `fair` | `high` | `outlier_high`. */
    verdict: text("verdict").notNull(),
    /** Human-readable rationale produced by procur. */
    rationale: text("rationale"),

    fetchedAt: timestamp("fetched_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    tenantIdx: index("fuel_deal_market_context_tenant_idx").on(t.tenantId),
    verdictIdx: index("fuel_deal_market_context_verdict_idx").on(t.verdict),
    /**
     * One row per deal. DealMarketContextAgent upserts on this conflict
     * target so re-evaluation overwrites in place. Composite with
     * tenant_id keeps the constraint RLS-friendly.
     */
    dealUnique: uniqueIndex("fuel_deal_market_context_deal_unique").on(
      t.tenantId,
      t.dealId,
    ),
  }),
);

export type FuelDealMarketContext = typeof fuelDealMarketContext.$inferSelect;
export type NewFuelDealMarketContext =
  typeof fuelDealMarketContext.$inferInsert;
