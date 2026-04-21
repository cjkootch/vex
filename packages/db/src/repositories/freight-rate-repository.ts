import { and, asc, desc, eq, gte, lte, sql } from "drizzle-orm";
import { createId } from "@vex/domain";
import type { Tx } from "../client.js";
import { freightRates, type FreightRate } from "../schema/freight-rates.js";
import type { VesselClass } from "../schema/enums.js";

/**
 * FreightRateRepository — time-series benchmark prices for tanker /
 * dry-bulk lanes (0019_vessels). Mirrors the FuelMarketRateRepository
 * pattern: getLatest, getRange, insert. Adds two market-aware helpers
 * the deal evaluator needs:
 *
 *   - nearestToDate: the rate "as of" a given lock date, with a small
 *     trailing window so a Friday lock can match Monday's publication
 *     when no weekend rate exists.
 *   - markToMarket: the latest rate vs. a deal's locked rate, returning
 *     the absolute and percent delta. Lets the evaluator surface
 *     "freight booked $4.20/MT below market" or the inverse without
 *     callers re-deriving.
 *
 * Stateless. Every method takes a `Tx` from `withTenant` so RLS scopes
 * the lookups; inserts also take `tenantId` for the WITH CHECK policy.
 */

export interface FreightRateRouteQuery {
  originRegion: string;
  destinationRegion: string;
  vesselClass: VesselClass;
  productCategory: string;
  /** Optional source filter — "baltic" / "platts" / "broker_circular" / "manual". */
  source?: string;
}

export interface FreightRateInsert {
  rateDate: string;
  originRegion: string;
  destinationRegion: string;
  vesselClass: VesselClass;
  productCategory: string;
  rateUsdPerMt: number;
  worldscalePoints?: number | null;
  source: string;
  sourceReference?: string | null;
  /** Explicit id — used by seed / fixture code. */
  id?: string;
}

export interface MarkToMarketResult {
  /** Latest published rate for the lane; null if none on file. */
  marketRateUsdPerMt: number | null;
  /** Absolute delta (positive = booked above market). */
  deltaUsdPerMt: number | null;
  /** Percent delta vs. market (positive = booked above market). */
  deltaPct: number | null;
  /** Date of the comparison rate. */
  asOfDate: string | null;
  source: string | null;
}

export class FreightRateRepository {
  /**
   * Most recent rate matching the lane. Source filter narrows to a
   * single publisher when the caller cares about a specific feed.
   */
  async getLatest(
    tx: Tx,
    query: FreightRateRouteQuery,
  ): Promise<FreightRate | null> {
    const [row] = await tx
      .select()
      .from(freightRates)
      .where(buildLaneClause(query))
      .orderBy(desc(freightRates.rateDate))
      .limit(1);
    return row ?? null;
  }

  /**
   * Inclusive date range. `from` / `to` are yyyy-mm-dd strings to
   * match Drizzle's `date` column type. Returns rows chronologically
   * so chart consumers don't have to re-sort.
   */
  async getRange(
    tx: Tx,
    query: FreightRateRouteQuery,
    from: string,
    to: string,
  ): Promise<FreightRate[]> {
    return tx
      .select()
      .from(freightRates)
      .where(
        and(
          buildLaneClause(query),
          gte(freightRates.rateDate, from),
          lte(freightRates.rateDate, to),
        ),
      )
      .orderBy(asc(freightRates.rateDate));
  }

  /**
   * Rate "as of" a given lock date. Looks up to {@link windowDays}
   * days backward (default 7) so a weekend / holiday lock matches the
   * most recent publication that preceded it. Returns null when no
   * rate exists in the window — callers should fall back to the
   * absolute latest via {@link getLatest}.
   */
  async nearestToDate(
    tx: Tx,
    query: FreightRateRouteQuery,
    targetDate: string,
    windowDays = 7,
  ): Promise<FreightRate | null> {
    const target = new Date(`${targetDate}T00:00:00Z`);
    if (Number.isNaN(target.getTime())) return null;
    const windowStart = new Date(target);
    windowStart.setUTCDate(windowStart.getUTCDate() - windowDays);
    const fromIso = windowStart.toISOString().slice(0, 10);
    const [row] = await tx
      .select()
      .from(freightRates)
      .where(
        and(
          buildLaneClause(query),
          gte(freightRates.rateDate, fromIso),
          lte(freightRates.rateDate, targetDate),
        ),
      )
      .orderBy(desc(freightRates.rateDate))
      .limit(1);
    return row ?? null;
  }

  /**
   * Mark a deal's locked freight rate against the current market.
   *
   * Convention: positive delta means the deal is paying ABOVE market
   * (bad for the buyer of the freight — VTC), negative means below
   * market (good). Returns null fields when no benchmark exists.
   */
  async markToMarket(
    tx: Tx,
    query: FreightRateRouteQuery,
    lockedRateUsdPerMt: number,
  ): Promise<MarkToMarketResult> {
    const market = await this.getLatest(tx, query);
    if (!market) {
      return {
        marketRateUsdPerMt: null,
        deltaUsdPerMt: null,
        deltaPct: null,
        asOfDate: null,
        source: null,
      };
    }
    const delta = lockedRateUsdPerMt - market.rateUsdPerMt;
    const pct = market.rateUsdPerMt > 0 ? delta / market.rateUsdPerMt : null;
    return {
      marketRateUsdPerMt: market.rateUsdPerMt,
      deltaUsdPerMt: delta,
      deltaPct: pct,
      asOfDate:
        typeof market.rateDate === "string"
          ? market.rateDate
          : (market.rateDate as Date).toISOString().slice(0, 10),
      source: market.source,
    };
  }

  /**
   * Idempotent insert. The migration's unique index on
   * (tenant, rate_date, origin, destination, class, product, source)
   * collapses re-publishes of the same row; we use an
   * `ON CONFLICT DO UPDATE` on the rate value so a corrected
   * republication (Baltic re-issues a fix) lands cleanly.
   */
  async insert(
    tx: Tx,
    tenantId: string,
    data: FreightRateInsert,
  ): Promise<FreightRate> {
    const [row] = await tx
      .insert(freightRates)
      .values({
        id: data.id ?? createId(),
        tenantId,
        rateDate: data.rateDate,
        originRegion: data.originRegion,
        destinationRegion: data.destinationRegion,
        vesselClass: data.vesselClass,
        productCategory: data.productCategory,
        rateUsdPerMt: data.rateUsdPerMt,
        worldscalePoints: data.worldscalePoints ?? null,
        source: data.source,
        sourceReference: data.sourceReference ?? null,
      })
      .onConflictDoUpdate({
        target: [
          freightRates.tenantId,
          freightRates.rateDate,
          freightRates.originRegion,
          freightRates.destinationRegion,
          freightRates.vesselClass,
          freightRates.productCategory,
          freightRates.source,
        ],
        set: {
          rateUsdPerMt: sql`excluded.rate_usd_per_mt`,
          worldscalePoints: sql`excluded.worldscale_points`,
          sourceReference: sql`excluded.source_reference`,
        },
      })
      .returning();
    if (!row) throw new Error("freight_rates insert returned no row");
    return row;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildLaneClause(query: FreightRateRouteQuery) {
  return and(
    eq(freightRates.originRegion, query.originRegion),
    eq(freightRates.destinationRegion, query.destinationRegion),
    eq(freightRates.vesselClass, query.vesselClass),
    eq(freightRates.productCategory, query.productCategory),
    ...(query.source ? [eq(freightRates.source, query.source)] : []),
  );
}
