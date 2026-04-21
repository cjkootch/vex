import { and, desc, inArray, isNotNull } from "drizzle-orm";
import { type DealStatus } from "@vex/domain";
import {
  FreightRateRepository,
  FuelDealRepository,
  SignalRepository,
  VesselRepository,
  schema,
  type FreightRateRouteQuery,
  type FuelDeal,
  type Vessel,
  type VesselClass,
} from "@vex/db";
import type { ProposedAction } from "@vex/integrations";
import type { AgentContext, AgentOutput, IAgent } from "./types.js";

/**
 * VesselIntelligenceAgent — bolts the vessel + freight dimensions
 * (added in 0019_vessels) into the deal-evaluation rail.
 *
 * Three concurrent jobs per deal:
 *
 *   1. Mark-to-market freight. The deal carries a locked
 *      freight_rate_usd_per_mt; this agent compares it to the latest
 *      published market rate for the lane via FreightRateRepository.
 *      Big positive deltas (booked above market) raise warnings.
 *   2. Vessel vetting. Walks the vessel's PSC inspection state — high
 *      deficiency counts or stale inspections fire critical/caution
 *      signals. Single-hull tankers raise a critical signal too
 *      (most flags ban them; nominating one is a charterparty risk).
 *   3. Utilization. Vessel utilization < 60% means a small cargo on
 *      a large hull — freight per USG balloons even when the
 *      headline rate is competitive. Caution signal.
 *
 * Two modes from one code path:
 *   - Targeted ({ dealId }): screens one deal. Triggered when a deal
 *     gains a vessel link.
 *   - Batch (no input): screens every open deal with a vessel_id.
 *     Designed for a daily / 6-hour cron once the lane→region map
 *     is broader than today's heuristic.
 *
 * Tier: T1 baseline (internal writes + signals only). Surfaces a T2
 * `deal.human_review` proposal whenever a critical condition fires
 * — same gating model the deal-evaluator already uses.
 *
 * No LLM calls — purely rule-based, costUsd is always 0.
 */

const MARK_TO_MARKET_CAUTION_PCT = 0.15; // booked >= 15% above market
const MARK_TO_MARKET_CRITICAL_PCT = 0.3; // booked >= 30% above market
const PSC_DEFICIENCIES_CAUTION = 5;
const PSC_DEFICIENCIES_CRITICAL = 10;
const PSC_STALE_DAYS = 365;
const UTILIZATION_CAUTION_PCT = 0.6;

const OPEN_DEAL_STATUSES: DealStatus[] = [
  "draft",
  "negotiating",
  "approved",
  "in_transit",
];

export interface VesselIntelligenceInput {
  /** Screen a single deal. Omit for batch. */
  dealId?: string;
}

interface DealFinding {
  deal: FuelDeal;
  vessel: Vessel | null;
  signals: Array<{
    ruleId: string;
    severity: "info" | "warn" | "critical";
    title: string;
    body: string;
    metadata: Record<string, unknown>;
  }>;
  needsReview: boolean;
  reviewReasons: string[];
}

export class VesselIntelligenceAgent implements IAgent {
  readonly name = "vessel_intelligence";
  /** Highest tier the agent can emit; clean runs leave proposedActions empty. */
  readonly tier = "T2" as const;

  private readonly deals = new FuelDealRepository();
  private readonly vessels = new VesselRepository();
  private readonly freight = new FreightRateRepository();
  private readonly signals = new SignalRepository();

  constructor(private readonly input: VesselIntelligenceInput = {}) {}

  async run(ctx: AgentContext): Promise<AgentOutput> {
    const dealsToScreen = await this.loadScope(ctx);
    if (dealsToScreen.length === 0) {
      return {
        costUsd: 0,
        outputRefs: { skipped: "no_deals", scope: this.input.dealId ?? "batch" },
        proposedActions: [],
        internalWrites: 0,
      };
    }

    let internalWrites = 0;
    let dealsFlagged = 0;
    const proposedActions: ProposedAction[] = [];
    const flaggedRefs: string[] = [];

    for (const deal of dealsToScreen) {
      const finding = await this.screenDeal(ctx, deal);

      // Persist signals — fire() is idempotent on (tenant, ruleId,
      // subjectId, open) so a re-run on an unchanged deal is a no-op.
      for (const s of finding.signals) {
        await this.signals.fire(ctx.tx, ctx.tenantId, {
          ruleId: s.ruleId,
          severity: s.severity,
          subjectType: "fuel_deal",
          subjectId: deal.id,
          title: s.title,
          body: s.body,
          metadata: s.metadata,
        });
        internalWrites++;
      }

      if (finding.needsReview) {
        dealsFlagged++;
        flaggedRefs.push(deal.dealRef);
        proposedActions.push({
          kind: "deal.human_review",
          tier: "T2",
          payload: {
            deal_id: deal.id,
            deal_ref: deal.dealRef,
            vessel_id: deal.vesselId,
            vessel_name: finding.vessel?.name ?? null,
            reasons: finding.reviewReasons,
            subject_id: deal.id,
          },
          rationale: `${deal.dealRef}: vessel/freight review — ${finding.reviewReasons.join("; ")}`,
        });
      }
    }

    return {
      costUsd: 0,
      outputRefs: {
        scanned: dealsToScreen.length,
        flagged: dealsFlagged,
        flagged_refs: flaggedRefs,
      },
      proposedActions,
      internalWrites,
      rationale:
        dealsFlagged > 0
          ? `${dealsFlagged}/${dealsToScreen.length} deals flagged for vessel/freight review`
          : `${dealsToScreen.length}/${dealsToScreen.length} deals clean`,
    };
  }

  // -------------------------------------------------------------------------
  // Scoping
  // -------------------------------------------------------------------------

  private async loadScope(ctx: AgentContext): Promise<FuelDeal[]> {
    if (this.input.dealId) {
      const deal = await this.deals.findById(ctx.tx, this.input.dealId);
      return deal ? [deal] : [];
    }
    // Batch — every open deal that has been linked to a vessel. Deals
    // without a vessel link are out of scope (nothing to vet).
    return ctx.tx
      .select()
      .from(schema.fuelDeals)
      .where(
        and(
          inArray(schema.fuelDeals.status, OPEN_DEAL_STATUSES),
          isNotNull(schema.fuelDeals.vesselId),
        ),
      )
      .orderBy(desc(schema.fuelDeals.updatedAt))
      .limit(500);
  }

  // -------------------------------------------------------------------------
  // Per-deal screening
  // -------------------------------------------------------------------------

  private async screenDeal(
    ctx: AgentContext,
    deal: FuelDeal,
  ): Promise<DealFinding> {
    const finding: DealFinding = {
      deal,
      vessel: null,
      signals: [],
      needsReview: false,
      reviewReasons: [],
    };

    // Pull the vessel — most checks need it.
    if (deal.vesselId) {
      finding.vessel = await this.vessels.findById(ctx.tx, deal.vesselId);
    }

    // 1. Freight mark-to-market. Only when the deal carries a locked
    //    rate AND we can derive a lane.
    if (
      deal.freightRateUsdPerMt &&
      deal.freightRateUsdPerMt > 0 &&
      finding.vessel
    ) {
      const lane = laneForDeal(deal, finding.vessel.vesselClass);
      if (lane) {
        const mtm = await this.freight.markToMarket(
          ctx.tx,
          lane,
          deal.freightRateUsdPerMt,
        );
        if (
          mtm.deltaPct !== null &&
          mtm.marketRateUsdPerMt !== null
        ) {
          if (mtm.deltaPct >= MARK_TO_MARKET_CRITICAL_PCT) {
            finding.signals.push({
              ruleId: "vessel.freight.above_market_critical",
              severity: "critical",
              title: `${deal.dealRef}: freight booked ${(mtm.deltaPct * 100).toFixed(1)}% above market`,
              body:
                `Locked $${deal.freightRateUsdPerMt.toFixed(2)}/MT vs market ` +
                `$${mtm.marketRateUsdPerMt.toFixed(2)}/MT (as of ${mtm.asOfDate}, ${mtm.source}). ` +
                `Threshold ${(MARK_TO_MARKET_CRITICAL_PCT * 100).toFixed(0)}%.`,
              metadata: { ...mtm, deal_id: deal.id, lane },
            });
            finding.needsReview = true;
            finding.reviewReasons.push(
              `freight ${(mtm.deltaPct * 100).toFixed(1)}% above market`,
            );
          } else if (mtm.deltaPct >= MARK_TO_MARKET_CAUTION_PCT) {
            finding.signals.push({
              ruleId: "vessel.freight.above_market_caution",
              severity: "warn",
              title: `${deal.dealRef}: freight ${(mtm.deltaPct * 100).toFixed(1)}% above market`,
              body:
                `Locked $${deal.freightRateUsdPerMt.toFixed(2)}/MT vs market ` +
                `$${mtm.marketRateUsdPerMt.toFixed(2)}/MT (as of ${mtm.asOfDate}, ${mtm.source}).`,
              metadata: { ...mtm, deal_id: deal.id, lane },
            });
          }
        }
      }
    }

    // 2. PSC vetting. Only when we have a vessel.
    if (finding.vessel) {
      const psc = pscFinding(finding.vessel);
      if (psc) finding.signals.push(psc);
      if (psc?.severity === "critical") {
        finding.needsReview = true;
        finding.reviewReasons.push(`vessel ${finding.vessel.name}: ${psc.title}`);
      }

      // Single-hull tankers — most flags ban; nominating one is a
      // charterparty + insurance risk.
      if (
        finding.vessel.doubleHull === false &&
        isTankerClass(finding.vessel.vesselClass)
      ) {
        finding.signals.push({
          ruleId: "vessel.single_hull",
          severity: "critical",
          title: `${deal.dealRef}: single-hull tanker nominated`,
          body:
            `Vessel ${finding.vessel.name} (IMO ${finding.vessel.imoNumber ?? "n/a"}) ` +
            `is single-hull. Most flags + most cargoes prohibit single-hull lift.`,
          metadata: {
            deal_id: deal.id,
            vessel_id: finding.vessel.id,
            vessel_class: finding.vessel.vesselClass,
          },
        });
        finding.needsReview = true;
        finding.reviewReasons.push("single-hull tanker");
      }
    }

    // 3. Utilization — small cargo on a big hull blows up $/USG even
    //    when the $/MT headline rate looks fine.
    if (
      deal.vesselUtilizationPct !== null &&
      deal.vesselUtilizationPct !== undefined &&
      deal.vesselUtilizationPct < UTILIZATION_CAUTION_PCT
    ) {
      finding.signals.push({
        ruleId: "vessel.utilization_low",
        severity: "warn",
        title: `${deal.dealRef}: vessel ${(deal.vesselUtilizationPct * 100).toFixed(0)}% utilized`,
        body:
          `Cargo fills only ${(deal.vesselUtilizationPct * 100).toFixed(1)}% of vessel capacity. ` +
          `Effective $/USG balloons; consider a smaller vessel or part-cargo.`,
        metadata: {
          deal_id: deal.id,
          utilization_pct: deal.vesselUtilizationPct,
          threshold: UTILIZATION_CAUTION_PCT,
        },
      });
    }

    return finding;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build a (origin, destination, class, productCategory) lane from a
 * deal + vessel class. Today's mapping is a coarse heuristic for the
 * Caribbean / US Gulf book; broaden the country→region table as new
 * lanes onboard. Returns null when either endpoint can't be mapped.
 */
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

/**
 * Country → region slug. Covers the lanes VTC actually trades; widen
 * this table (or hoist into the workspace settings) once the agent
 * starts marking deals on routes outside the Caribbean / US Gulf.
 */
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
  // Refined products vs heavy fuel oil vs LPG / LNG. Maps to the
  // freight_rates.product_category convention.
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

function isTankerClass(c: VesselClass): boolean {
  return (
    c === "mr_tanker" ||
    c === "lr1" ||
    c === "lr2" ||
    c === "vlcc" ||
    c === "aframax" ||
    c === "suezmax" ||
    c === "panamax" ||
    c === "handysize" ||
    c === "handymax" ||
    c === "coastal" ||
    c === "barge"
  );
}

/**
 * PSC inspection assessment. Two cuts:
 *   - High deficiency count on the latest inspection.
 *   - Stale inspection (no inspection in PSC_STALE_DAYS).
 */
function pscFinding(vessel: Vessel): {
  ruleId: string;
  severity: "info" | "warn" | "critical";
  title: string;
  body: string;
  metadata: Record<string, unknown>;
} | null {
  const def = vessel.lastPscDeficiencies ?? null;
  const lastDate = vessel.lastPscInspectionDate;

  if (def !== null && def >= PSC_DEFICIENCIES_CRITICAL) {
    return {
      ruleId: "vessel.psc.deficiencies_critical",
      severity: "critical",
      title: `Vessel ${vessel.name}: ${def} PSC deficiencies on last inspection`,
      body:
        `${vessel.name} (IMO ${vessel.imoNumber ?? "n/a"}) had ${def} deficiencies ` +
        `at last PSC inspection (${lastDate ?? "date unknown"}). Above-${PSC_DEFICIENCIES_CRITICAL} thresholds drive detention risk.`,
      metadata: {
        vessel_id: vessel.id,
        deficiencies: def,
        last_inspection: lastDate,
      },
    };
  }
  if (def !== null && def >= PSC_DEFICIENCIES_CAUTION) {
    return {
      ruleId: "vessel.psc.deficiencies_caution",
      severity: "warn",
      title: `Vessel ${vessel.name}: ${def} PSC deficiencies on last inspection`,
      body:
        `${vessel.name} (IMO ${vessel.imoNumber ?? "n/a"}) had ${def} deficiencies ` +
        `at last PSC inspection (${lastDate ?? "date unknown"}). Review before charter.`,
      metadata: {
        vessel_id: vessel.id,
        deficiencies: def,
        last_inspection: lastDate,
      },
    };
  }

  if (lastDate) {
    const inspectedAt = new Date(`${lastDate}T00:00:00Z`).getTime();
    if (Number.isFinite(inspectedAt)) {
      const ageDays = (Date.now() - inspectedAt) / (24 * 60 * 60 * 1000);
      if (ageDays > PSC_STALE_DAYS) {
        return {
          ruleId: "vessel.psc.stale",
          severity: "warn",
          title: `Vessel ${vessel.name}: PSC inspection ${Math.floor(ageDays)} days old`,
          body:
            `Last PSC inspection on ${lastDate} (${Math.floor(ageDays)} days ago). ` +
            `Cut-off is ${PSC_STALE_DAYS} days; request a fresh vetting before fixture.`,
          metadata: {
            vessel_id: vessel.id,
            last_inspection: lastDate,
            age_days: Math.floor(ageDays),
          },
        };
      }
    }
  }
  return null;
}
