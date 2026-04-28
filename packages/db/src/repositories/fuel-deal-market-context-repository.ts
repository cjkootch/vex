import { eq } from "drizzle-orm";
import { createId } from "@vex/domain";
import type { Tx } from "../client.js";
import {
  fuelDealMarketContext,
  type FuelDealMarketContext,
} from "../schema/fuel-deal-market-context.js";

export interface FuelDealMarketContextUpsertInput {
  dealId: string;
  benchmarkCode: string;
  benchmarkSpotUsd: number | null;
  effectiveBenchmarkUsd: number | null;
  offerDeltaUsd: number | null;
  offerDeltaPct: number | null;
  historicalMeanDeltaPct: number | null;
  historicalMedianDeltaPct: number | null;
  historicalStddevDeltaPct: number | null;
  historicalSampleSize: number | null;
  zScore: number | null;
  percentile: number | null;
  /** `aggressive` | `competitive` | `fair` | `high` | `outlier_high`. */
  verdict: string;
  rationale: string | null;
}

/**
 * Repository for `fuel_deal_market_context`. One row per deal,
 * upserted by `DealMarketContextAgent` on the draft→live transition
 * or on explicit operator-triggered re-evaluation.
 *
 * The unique constraint on (tenant_id, deal_id) means re-runs
 * overwrite the previous evaluation rather than stacking — operators
 * see the freshest verdict, not a history. If we ever need a
 * trail of evaluations, that's a separate `fuel_deal_market_context_history`
 * table; the current shape is intentionally one-row-per-deal.
 */
export class FuelDealMarketContextRepository {
  async upsert(
    tx: Tx,
    tenantId: string,
    input: FuelDealMarketContextUpsertInput,
  ): Promise<FuelDealMarketContext> {
    const id = createId();
    const fetchedAt = new Date();
    const [row] = await tx
      .insert(fuelDealMarketContext)
      .values({
        id,
        tenantId,
        dealId: input.dealId,
        benchmarkCode: input.benchmarkCode,
        benchmarkSpotUsd: input.benchmarkSpotUsd,
        effectiveBenchmarkUsd: input.effectiveBenchmarkUsd,
        offerDeltaUsd: input.offerDeltaUsd,
        offerDeltaPct: input.offerDeltaPct,
        historicalMeanDeltaPct: input.historicalMeanDeltaPct,
        historicalMedianDeltaPct: input.historicalMedianDeltaPct,
        historicalStddevDeltaPct: input.historicalStddevDeltaPct,
        historicalSampleSize: input.historicalSampleSize,
        zScore: input.zScore,
        percentile: input.percentile,
        verdict: input.verdict,
        rationale: input.rationale,
        fetchedAt,
      })
      .onConflictDoUpdate({
        target: [
          fuelDealMarketContext.tenantId,
          fuelDealMarketContext.dealId,
        ],
        set: {
          benchmarkCode: input.benchmarkCode,
          benchmarkSpotUsd: input.benchmarkSpotUsd,
          effectiveBenchmarkUsd: input.effectiveBenchmarkUsd,
          offerDeltaUsd: input.offerDeltaUsd,
          offerDeltaPct: input.offerDeltaPct,
          historicalMeanDeltaPct: input.historicalMeanDeltaPct,
          historicalMedianDeltaPct: input.historicalMedianDeltaPct,
          historicalStddevDeltaPct: input.historicalStddevDeltaPct,
          historicalSampleSize: input.historicalSampleSize,
          zScore: input.zScore,
          percentile: input.percentile,
          verdict: input.verdict,
          rationale: input.rationale,
          fetchedAt,
        },
      })
      .returning();
    if (!row) {
      throw new Error("fuel_deal_market_context upsert returned no row");
    }
    return row;
  }

  /** Fetch the most-recent (and only) evaluation for a deal. Null when none recorded. */
  async findByDealId(
    tx: Tx,
    dealId: string,
  ): Promise<FuelDealMarketContext | null> {
    const rows = await tx
      .select()
      .from(fuelDealMarketContext)
      .where(eq(fuelDealMarketContext.dealId, dealId))
      .limit(1);
    return rows[0] ?? null;
  }
}
