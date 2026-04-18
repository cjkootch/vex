import {
  CounterpartyRiskRepository,
  FuelDealRepository,
  FuelMarketRateRepository,
  type FuelMarketRate,
} from "@vex/db";
import type { ProposedAction } from "@vex/integrations";
import {
  scoreBuyerReadiness,
  type BuyerReadinessSignals,
  type BuyerReadinessResult,
} from "../scoring/buyer-readiness.js";
import type { AgentContext, AgentOutput, IAgent } from "./types.js";

/**
 * Market alert agent — fires after MarketDataAgent lands a fresh tick.
 *
 * Scans the most recent market rate for each (product, benchmark) pair,
 * compares to a rolling 30-day baseline, and for any threshold crossing
 * identifies buyers who have historically traded that product. Each
 * candidate buyer is scored via scoreBuyerReadiness; hot/warm buyers
 * generate a T2 `market.outreach` proposed action the ApprovalGate turns
 * into an approval row. Prohibited counterparties are never proposed
 * regardless of score.
 *
 * The agent is deliberately read-mostly: the only writes it performs
 * beyond approval rows are audit events. It relies on the outer
 * AgentRunner to gate T2+ through ApprovalGate — the agent itself
 * returns the `proposedActions` and lets the runner decide.
 *
 * Product mapping — the market feed uses canonical labels (`diesel`,
 * `gasoline`, `crude`, `natural_gas`, `jet`) which don't line up 1:1
 * with the deal schema's productType enum (`ulsd`, `gasoline_87`,
 * `jet_a`, …). The constructor takes an explicit map so the agent stays
 * decoupled from any particular mapping choice.
 */

export interface MarketAlertAgentInput {
  /** Repositories — injected so the agent stays testable. */
  rates: FuelMarketRateRepository;
  deals: FuelDealRepository;
  counterparty: CounterpartyRiskRepository;
  /**
   * Product-mapping: rate.product → deal.product[]. A single rate label
   * may map to several deal product codes (e.g. `gasoline` → `gasoline_87` +
   * `gasoline_91`).
   */
  productMap: Record<string, string[]>;
  /** Baseline window for the % move check. Default 30 days. */
  baselineDays?: number;
  /** Threshold crossing: absolute % change vs baseline. Default 5. */
  thresholdPct?: number;
}

export interface MarketAlertCrossing {
  product: string;
  benchmark: string;
  currentPriceUsg: number;
  baselinePriceUsg: number;
  changePct: number;
  direction: "up" | "down";
  rateDate: string;
}

/**
 * Alert proposals are captured on the run's output_refs so the panel /
 * audit trail has a structured record even for buyers that didn't clear
 * the readiness bar.
 */
export interface MarketAlertCandidate {
  orgId: string;
  orgName: string;
  product: string;
  benchmark: string;
  changePct: number;
  direction: "up" | "down";
  readiness: BuyerReadinessResult;
  proposed: boolean;
  skipReason?: string;
}

export class MarketAlertAgent implements IAgent {
  readonly name = "market_alert";
  readonly tier = "T2" as const;

  constructor(private readonly input: MarketAlertAgentInput) {}

  async run(ctx: AgentContext): Promise<AgentOutput> {
    const baselineDays = this.input.baselineDays ?? 30;
    const thresholdPct = this.input.thresholdPct ?? 5;

    const crossings = await this.detectCrossings(ctx, baselineDays, thresholdPct);
    if (crossings.length === 0) {
      return {
        costUsd: 0,
        outputRefs: { crossings: [], candidates: [] },
        proposedActions: [],
        internalWrites: 0,
        rationale: "no threshold crossings",
      };
    }

    const candidates: MarketAlertCandidate[] = [];
    const proposedActions: ProposedAction[] = [];

    for (const crossing of crossings) {
      const buyerIds = await this.candidateBuyers(ctx, crossing.product);
      for (const orgId of buyerIds) {
        const signals = await this.signalsFor(ctx, orgId, crossing);
        const readiness = scoreBuyerReadiness(signals);
        const org = await ctx.organizations.findById(ctx.tx, orgId);
        const orgName = org?.legalName ?? orgId;
        const shouldPropose = !readiness.blocked && (readiness.band === "hot" || readiness.band === "warm");

        candidates.push({
          orgId,
          orgName,
          product: crossing.product,
          benchmark: crossing.benchmark,
          changePct: crossing.changePct,
          direction: crossing.direction,
          readiness,
          proposed: shouldPropose,
          ...(shouldPropose ? {} : { skipReason: readiness.blocked ? (readiness.blockReason ?? "blocked") : `band=${readiness.band}` }),
        });

        if (shouldPropose) {
          proposedActions.push({
            kind: "market.outreach",
            tier: "T2",
            payload: {
              org_id: orgId,
              org_name: orgName,
              product: crossing.product,
              benchmark: crossing.benchmark,
              current_price_usg: crossing.currentPriceUsg,
              baseline_price_usg: crossing.baselinePriceUsg,
              change_pct: crossing.changePct,
              direction: crossing.direction,
              rate_date: crossing.rateDate,
              readiness_score: readiness.score,
              readiness_band: readiness.band,
              contributions: readiness.contributions,
            },
            rationale: `${crossing.product} ${crossing.direction} ${crossing.changePct.toFixed(1)}% vs ${baselineDays}d baseline — ${orgName} readiness=${readiness.score} (${readiness.band})`,
          });
        }
      }

      await ctx.events.insertIfNotExists(ctx.tx, ctx.tenantId, {
        verb: "agent.market_alert.crossing_detected",
        subjectType: "market_series",
        subjectId: `${crossing.product}:${crossing.benchmark}`,
        actorType: "system",
        actorId: this.name,
        objectType: "market_series",
        objectId: `${crossing.product}:${crossing.benchmark}`,
        occurredAt: new Date(),
        idempotencyKey: `market_alert.crossing:${crossing.product}:${crossing.benchmark}:${crossing.rateDate}`,
        metadata: {
          change_pct: crossing.changePct,
          direction: crossing.direction,
          current_price_usg: crossing.currentPriceUsg,
          baseline_price_usg: crossing.baselinePriceUsg,
          baseline_days: baselineDays,
          threshold_pct: thresholdPct,
        },
      });
    }

    return {
      costUsd: 0,
      outputRefs: {
        crossings,
        candidates,
        baseline_days: baselineDays,
        threshold_pct: thresholdPct,
      },
      proposedActions,
      internalWrites: crossings.length,
      rationale: `${crossings.length} crossing(s) → ${proposedActions.length} outreach proposal(s)`,
    };
  }

  private async detectCrossings(
    ctx: AgentContext,
    baselineDays: number,
    thresholdPct: number,
  ): Promise<MarketAlertCrossing[]> {
    const latest = await this.input.rates.listLatestPerSeries(ctx.tx, 100);
    if (latest.length === 0) return [];

    const crossings: MarketAlertCrossing[] = [];
    for (const row of latest) {
      const baseline = await this.baseline(ctx, row, baselineDays);
      if (baseline === null) continue;
      const delta = ((row.pricePerUsg - baseline) / baseline) * 100;
      if (Math.abs(delta) < thresholdPct) continue;
      crossings.push({
        product: row.product,
        benchmark: row.benchmark,
        currentPriceUsg: row.pricePerUsg,
        baselinePriceUsg: round(baseline, 6),
        changePct: round(delta, 2),
        direction: delta >= 0 ? "up" : "down",
        rateDate: row.rateDate,
      });
    }
    return crossings;
  }

  private async baseline(
    ctx: AgentContext,
    row: FuelMarketRate,
    baselineDays: number,
  ): Promise<number | null> {
    const end = row.rateDate;
    const startDate = new Date(row.rateDate);
    startDate.setUTCDate(startDate.getUTCDate() - baselineDays);
    const start = startDate.toISOString().slice(0, 10);
    const range = await this.input.rates.getRange(ctx.tx, row.product, row.benchmark, start, end);
    const priorValues = range
      .filter((r) => r.rateDate !== row.rateDate)
      .map((r) => r.pricePerUsg);
    if (priorValues.length < 5) return null;
    const sum = priorValues.reduce((a, b) => a + b, 0);
    return sum / priorValues.length;
  }

  private async candidateBuyers(ctx: AgentContext, marketProduct: string): Promise<string[]> {
    const dealProducts = this.input.productMap[marketProduct] ?? [];
    if (dealProducts.length === 0) return [];
    const matching = await this.input.deals.findByStatus(ctx.tx, [
      "draft",
      "negotiating",
      "pending_approval",
      "approved",
      "loading",
      "in_transit",
      "delivered",
      "settled",
    ]);
    const dealProductSet = new Set(dealProducts);
    const seen = new Set<string>();
    for (const deal of matching) {
      if (dealProductSet.has(deal.product)) seen.add(deal.buyerOrgId);
    }
    return Array.from(seen);
  }

  private async signalsFor(
    ctx: AgentContext,
    orgId: string,
    crossing: MarketAlertCrossing,
  ): Promise<BuyerReadinessSignals> {
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const [score, touchpoints, deals, pendingApprovals] = await Promise.all([
      this.input.counterparty.score(ctx.tx, orgId),
      ctx.touchpoints.listForOrgSince(ctx.tx, orgId, thirtyDaysAgo, 200),
      this.input.deals.findByBuyer(ctx.tx, orgId),
      ctx.approvals.listByDecision(ctx.tx, "pending", 200),
    ]);

    const inbound = touchpoints.filter((t) => t.actor === null || t.actor === orgId);
    const lastInbound = inbound[0]?.occurredAt ?? null;
    const daysSinceLastInbound = lastInbound
      ? Math.max(0, Math.floor((Date.now() - lastInbound.getTime()) / (24 * 60 * 60 * 1000)))
      : null;

    const activeDealCount = deals.filter((d) =>
      ["draft", "negotiating", "pending_approval", "approved", "loading", "in_transit"].includes(d.status),
    ).length;

    const openFollowUpCount = pendingApprovals.filter((a) => {
      if (!a.actionType.startsWith("follow_up")) return false;
      const payload = a.proposedPayload as { org_id?: string } | null;
      return payload?.org_id === orgId;
    }).length;

    // Price favorability: for a buyer, a DOWN move is favorable (cheaper
    // cost basis). Map the crossing's direction accordingly. Magnitude
    // is normalised so a 5% move ≈ 0.25 favorability, 20%+ saturates.
    const magnitude = Math.min(Math.abs(crossing.changePct) / 20, 1);
    const priceFavorability = crossing.direction === "down" ? magnitude : -magnitude;

    return {
      counterpartyTier: mapRiskTier(score?.riskTier ?? null),
      counterpartyComposite: score?.compositeScore ?? null,
      touchpointCount30d: touchpoints.length,
      daysSinceLastInbound,
      openFollowUpCount,
      activeDealCount,
      priceFavorability,
    };
  }
}

function round(n: number, digits: number): number {
  const f = 10 ** digits;
  return Math.round(n * f) / f;
}

/**
 * The counterparty risk tier enum uses `tier_1` / `tier_2` / `tier_3` /
 * `watch` / `declined`. The buyer-readiness scorer speaks the more
 * portable `low` / `medium` / `high` / `prohibited`. Map here so
 * operators can tune the scorer in isolation without coupling to our
 * tier terminology.
 */
function mapRiskTier(
  tier: string | null,
): BuyerReadinessSignals["counterpartyTier"] {
  switch (tier) {
    case "tier_1":
      return "low";
    case "tier_2":
      return "medium";
    case "tier_3":
      return "high";
    case "watch":
      return "high";
    case "declined":
      return "prohibited";
    default:
      return null;
  }
}
