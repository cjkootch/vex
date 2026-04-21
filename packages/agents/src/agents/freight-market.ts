import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { type DealStatus } from "@vex/domain";
import {
  FreightRateRepository,
  FuelDealRepository,
  SignalRepository,
  schema,
  type FreightRateInsert,
  type FreightRateRouteQuery,
  type FuelDeal,
  type VesselClass,
} from "@vex/db";
import type { ProposedAction } from "@vex/integrations";
import type { AgentContext, AgentOutput, IAgent } from "./types.js";

/**
 * FreightMarketAgent — T1 cron agent that owns the freight side of
 * the vessel intelligence rail. Two responsibilities:
 *
 *   1. INGEST — pull the latest market freight rates for every
 *      Caribbean lane VTC actively trades, and write them to
 *      freight_rates (idempotent via the unique index from 0019).
 *      For sprint 1 the source is a hand-curated table inline below.
 *      TODO: wire Baltic Exchange RSS / broker circular ingestion
 *      so this method swaps to a real feed without touching the rest
 *      of the agent.
 *
 *   2. FLAG SHIFTS + GAPS — for every open deal:
 *        - With a vessel_id and a recorded
 *          freight_market_rate_at_lock: compare today's rate to the
 *          locked benchmark; deviation > 10% fires a "freight.rate_shift"
 *          signal (warn) or > 20% fires it as "critical".
 *        - With laycan within 14 days but no
 *          freight_rate_usd_per_mt yet: fire
 *          "freight.rate_missing" (warn) so the desk locks freight
 *          before the lay window opens.
 *
 * Tier T1 — internal writes + signals only. No outbound side effects.
 * The deal-evaluator's T2 review path picks up critical signals on the
 * next pass (or the operator clicks through from the signals inbox).
 *
 * Cron: 06:00 UTC daily — registered in queues.ts. Also runnable
 * on-demand from the admin panel.
 */

const SHIFT_WARN_PCT = 0.1;     // |delta| >= 10% => warn signal
const SHIFT_CRITICAL_PCT = 0.2; // |delta| >= 20% => critical signal
const LAYCAN_WINDOW_DAYS = 14;

const OPEN_DEAL_STATUSES: DealStatus[] = [
  "negotiating",
  "approved",
  "in_transit",
];

export class FreightMarketAgent implements IAgent {
  readonly name = "freight_market";
  readonly tier = "T1" as const;

  private readonly deals = new FuelDealRepository();
  private readonly freight = new FreightRateRepository();
  private readonly signals = new SignalRepository();

  async run(ctx: AgentContext): Promise<AgentOutput> {
    // 1. INGEST — write today's curated rates. Idempotent ON CONFLICT
    //    in FreightRateRepository.insert means re-running mid-day is
    //    a no-op for unchanged rates.
    const today = new Date().toISOString().slice(0, 10);
    const ingested = await this.ingestFreightRates(ctx, today);
    let internalWrites = ingested;

    // 2. FLAG — pull every open deal that has any freight context to
    //    score: either a vessel link (so we can mark to market) or a
    //    laycan inside the 14-day window (so we can flag a missing
    //    rate). Other deals are out of scope for this pass.
    const dealsToScore = await this.loadOpenDealsWithFreightContext(ctx);
    let shiftWarn = 0;
    let shiftCritical = 0;
    let missingFlagged = 0;
    const proposedActions: ProposedAction[] = [];

    const today14 = new Date();
    today14.setUTCDate(today14.getUTCDate() + LAYCAN_WINDOW_DAYS);
    const laycanCutoff = today14.toISOString().slice(0, 10);

    for (const deal of dealsToScore) {
      // Mark-to-market shift detection. Skips deals with no
      // market_rate_at_lock (they were never priced against a
      // benchmark, so there's nothing to deviate from).
      if (
        deal.vesselId &&
        deal.freightMarketRateAtLock !== null &&
        deal.freightMarketRateAtLock !== undefined &&
        deal.freightMarketRateAtLock > 0
      ) {
        const vesselClass = await this.lookupVesselClass(ctx, deal.vesselId);
        if (vesselClass) {
          const lane = laneForDeal(deal, vesselClass);
          if (lane) {
            const market = await this.freight.getLatest(ctx.tx, lane);
            if (market) {
              const delta =
                (market.rateUsdPerMt - deal.freightMarketRateAtLock) /
                deal.freightMarketRateAtLock;
              const absDelta = Math.abs(delta);
              if (absDelta >= SHIFT_CRITICAL_PCT) {
                shiftCritical++;
                await this.fireShiftSignal(ctx, deal, market.rateUsdPerMt, delta, "critical");
                internalWrites++;
                proposedActions.push({
                  kind: "deal.human_review",
                  tier: "T2",
                  payload: {
                    deal_id: deal.id,
                    deal_ref: deal.dealRef,
                    reason: "freight_market_shift",
                    delta_pct: delta,
                    market_rate_usd_per_mt: market.rateUsdPerMt,
                    market_rate_at_lock: deal.freightMarketRateAtLock,
                    subject_id: deal.id,
                  },
                  rationale:
                    `${deal.dealRef}: market freight has moved ` +
                    `${(delta * 100).toFixed(1)}% since lock.`,
                });
              } else if (absDelta >= SHIFT_WARN_PCT) {
                shiftWarn++;
                await this.fireShiftSignal(ctx, deal, market.rateUsdPerMt, delta, "warn");
                internalWrites++;
              }
            }
          }
        }
      }

      // Missing-rate flag — only when a laycan is set and inside the
      // window. Deals without laycan can't be timed; deals far out
      // don't need a rate yet.
      if (
        (deal.freightRateUsdPerMt === null ||
          deal.freightRateUsdPerMt === undefined ||
          deal.freightRateUsdPerMt === 0) &&
        deal.laycanStart &&
        deal.laycanStart <= laycanCutoff
      ) {
        await this.signals.fire(ctx.tx, ctx.tenantId, {
          ruleId: "freight.rate_missing",
          severity: "warn",
          subjectType: "fuel_deal",
          subjectId: deal.id,
          title: `${deal.dealRef}: freight rate not locked, laycan in ${daysUntil(deal.laycanStart)} days`,
          body:
            `Deal ${deal.dealRef} has laycan starting ${deal.laycanStart} ` +
            `but no freight_rate_usd_per_mt on file. Lock freight before the ` +
            `lay window opens or face spot-market exposure.`,
          metadata: {
            deal_id: deal.id,
            laycan_start: deal.laycanStart,
            window_days: LAYCAN_WINDOW_DAYS,
          },
        });
        missingFlagged++;
        internalWrites++;
      }
    }

    return {
      costUsd: 0,
      outputRefs: {
        rates_ingested: ingested,
        deals_scored: dealsToScore.length,
        shift_warn: shiftWarn,
        shift_critical: shiftCritical,
        missing_flagged: missingFlagged,
        sdn_list_date: today,
      },
      proposedActions,
      internalWrites,
      rationale:
        shiftCritical + shiftWarn + missingFlagged > 0
          ? `${shiftCritical} critical / ${shiftWarn} warn shifts; ${missingFlagged} missing rates`
          : `${dealsToScore.length} deals clean; ${ingested} rates ingested`,
    };
  }

  // -------------------------------------------------------------------------
  // INGEST
  // -------------------------------------------------------------------------

  /**
   * Returns the count of rate rows written. Re-runs same day are no-ops
   * thanks to ON CONFLICT DO UPDATE in FreightRateRepository.insert.
   */
  private async ingestFreightRates(
    ctx: AgentContext,
    rateDate: string,
  ): Promise<number> {
    const rates = this.fetchFreightRates(rateDate);
    let written = 0;
    for (const r of rates) {
      await this.freight.insert(ctx.tx, ctx.tenantId, r);
      written++;
    }
    return written;
  }

  /**
   * Curated freight rate snapshot for the Caribbean book. Hand-set
   * for sprint 1 — see SEED_FREIGHT_RATES below. Replace this method
   * body with a Baltic / broker feed adapter when one lands; everything
   * else in the agent stays the same.
   */
  private fetchFreightRates(rateDate: string): FreightRateInsert[] {
    return SEED_FREIGHT_RATES.map((r) => ({ ...r, rateDate }));
  }

  // -------------------------------------------------------------------------
  // SCORING
  // -------------------------------------------------------------------------

  private async loadOpenDealsWithFreightContext(
    ctx: AgentContext,
  ): Promise<FuelDeal[]> {
    const cutoff = new Date();
    cutoff.setUTCDate(cutoff.getUTCDate() + LAYCAN_WINDOW_DAYS);
    const cutoffIso = cutoff.toISOString().slice(0, 10);
    return ctx.tx
      .select()
      .from(schema.fuelDeals)
      .where(
        and(
          inArray(schema.fuelDeals.status, OPEN_DEAL_STATUSES),
          // Either we have a vessel link (eligible for mark-to-market)
          // or a near-laycan with a missing rate (eligible for the
          // missing-rate flag).
          sql`(
            ${schema.fuelDeals.vesselId} IS NOT NULL
            OR (
              ${schema.fuelDeals.laycanStart} IS NOT NULL
              AND ${schema.fuelDeals.laycanStart} <= ${cutoffIso}
              AND (
                ${schema.fuelDeals.freightRateUsdPerMt} IS NULL
                OR ${schema.fuelDeals.freightRateUsdPerMt} = 0
              )
            )
          )`,
        ),
      )
      .orderBy(desc(schema.fuelDeals.updatedAt))
      .limit(500);
  }

  private async lookupVesselClass(
    ctx: AgentContext,
    vesselId: string,
  ): Promise<VesselClass | null> {
    const [row] = await ctx.tx
      .select({ vesselClass: schema.vessels.vesselClass })
      .from(schema.vessels)
      .where(eq(schema.vessels.id, vesselId))
      .limit(1);
    return row?.vesselClass ?? null;
  }

  private async fireShiftSignal(
    ctx: AgentContext,
    deal: FuelDeal,
    currentRate: number,
    delta: number,
    severity: "warn" | "critical",
  ): Promise<void> {
    const sign = delta >= 0 ? "+" : "-";
    const pct = (Math.abs(delta) * 100).toFixed(1);
    await this.signals.fire(ctx.tx, ctx.tenantId, {
      ruleId: "freight.rate_shift",
      severity,
      subjectType: "fuel_deal",
      subjectId: deal.id,
      title: `${deal.dealRef}: freight market has moved ${sign}${pct}% since lock`,
      body:
        `Deal locked against $${(deal.freightMarketRateAtLock ?? 0).toFixed(2)}/MT. ` +
        `Current market $${currentRate.toFixed(2)}/MT (${sign}${pct}%). ` +
        `Booked rate $${(deal.freightRateUsdPerMt ?? 0).toFixed(2)}/MT.`,
      metadata: {
        deal_id: deal.id,
        market_rate_usd_per_mt: currentRate,
        market_rate_at_lock: deal.freightMarketRateAtLock,
        booked_rate_usd_per_mt: deal.freightRateUsdPerMt,
        delta_pct: delta,
      },
    });
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function laneForDeal(
  deal: FuelDeal,
  vesselClass: VesselClass,
): FreightRateRouteQuery | null {
  const origin = regionForCountry(deal.originCountry);
  const destination = regionForCountry(deal.destinationCountry);
  if (!origin || !destination) return null;
  return {
    originRegion: origin,
    destinationRegion: destination,
    vesselClass,
    productCategory: productCategoryForProduct(deal.product),
  };
}

function regionForCountry(country: string | null): string | null {
  if (!country) return null;
  const c = country.toUpperCase();
  if (c === "US" || c === "USA") return "USGC";
  if (
    c === "JM" ||
    c === "DO" ||
    c === "TT" ||
    c === "BB" ||
    c === "GT" ||
    c === "CR" ||
    c === "PA" ||
    c === "BS" ||
    c === "HT"
  ) {
    return "Caribs";
  }
  if (c === "MX") return "ECCA";
  return null;
}

function productCategoryForProduct(product: string): string {
  if (
    product === "ulsd" ||
    product === "gasoline_87" ||
    product === "gasoline_91" ||
    product === "jet_a" ||
    product === "jet_a1" ||
    product === "avgas" ||
    product === "lfo" ||
    product === "biodiesel_b20"
  ) {
    return "clean_products";
  }
  if (product === "hfo") return "dirty";
  if (product === "lng") return "lng";
  if (product === "lpg") return "lpg";
  return "clean_products";
}

function daysUntil(dateStr: string): number {
  const target = new Date(`${dateStr}T00:00:00Z`).getTime();
  if (!Number.isFinite(target)) return 0;
  const days = (target - Date.now()) / (24 * 60 * 60 * 1000);
  return Math.max(0, Math.round(days));
}

// ---------------------------------------------------------------------------
// Curated seed rates (rateDate is filled in at runtime).
// TODO: wire Baltic Exchange RSS / broker circular ingestion so this
// table swaps for a real feed without touching anything else in the agent.
// ---------------------------------------------------------------------------

type SeedRate = Omit<FreightRateInsert, "rateDate">;

const SEED_FREIGHT_RATES: SeedRate[] = [
  // USGC → Caribs, MR clean products — the highest-volume lane in
  // VTC's book. Baltic Dirty / Clean indices give us a reference $/MT
  // we can refresh manually until a feed lands.
  {
    originRegion: "USGC",
    destinationRegion: "Caribs",
    vesselClass: "mr_tanker",
    productCategory: "clean_products",
    rateUsdPerMt: 28.5,
    worldscalePoints: null,
    source: "manual",
    sourceReference: "vtc-curated-2026-04",
  },
  {
    originRegion: "USGC",
    destinationRegion: "Caribs",
    vesselClass: "lr1",
    productCategory: "clean_products",
    rateUsdPerMt: 24.8,
    worldscalePoints: null,
    source: "manual",
    sourceReference: "vtc-curated-2026-04",
  },
  // USGC → Caribs HFO (dirty)
  {
    originRegion: "USGC",
    destinationRegion: "Caribs",
    vesselClass: "aframax",
    productCategory: "dirty",
    rateUsdPerMt: 22.1,
    worldscalePoints: null,
    source: "manual",
    sourceReference: "vtc-curated-2026-04",
  },
  // ECCA → Caribs (Mexico Gulf coast → Caribbean) — short-haul MR.
  {
    originRegion: "ECCA",
    destinationRegion: "Caribs",
    vesselClass: "mr_tanker",
    productCategory: "clean_products",
    rateUsdPerMt: 19.4,
    worldscalePoints: null,
    source: "manual",
    sourceReference: "vtc-curated-2026-04",
  },
  // Inter-Caribs coastal / barge work for terminal-to-terminal hops.
  {
    originRegion: "Caribs",
    destinationRegion: "Caribs",
    vesselClass: "coastal",
    productCategory: "clean_products",
    rateUsdPerMt: 14.0,
    worldscalePoints: null,
    source: "manual",
    sourceReference: "vtc-curated-2026-04",
  },
];

