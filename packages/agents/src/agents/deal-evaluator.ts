import { createId, TenantId } from "@vex/domain";
import { eq } from "drizzle-orm";
import {
  calculateFuelDeal,
  CounterpartyRiskRepository,
  FuelDealRepository,
  FuelDealScenarioRepository,
  FuelMarketRateRepository,
  schema,
  type DealComplianceState,
  type DealWarning,
  type FuelDeal,
  type FuelDealInputs,
  type FuelDealResults,
  type FuelDealScenario,
  type Tx,
} from "@vex/db";
import type { ProposedAction } from "@vex/integrations";
import type { AgentContext, AgentOutput, IAgent } from "./types.js";

/**
 * T1 cron / on-demand agent. Recomputes a fuel deal's scorecard against
 * the active scenario and persists the full {@link FuelDealResults} on the
 * scenario row. The calculator itself is deterministic (see
 * `packages/db/src/deals/calculator.ts`), so re-running the agent against
 * unchanged inputs produces byte-identical `results_json` and does not
 * create duplicate summary versions with new content — the summary text
 * is built from the same deterministic template.
 *
 * T1 because it only performs internal writes (scenario update, summary
 * upsert, audit event) and may propose a T2 `deal.human_review` action
 * when the calculator recommends `do_not_proceed`. The AgentRunner routes
 * the T2 action through ApprovalGate so no external side effects fire
 * inline.
 */

export interface DealEvaluatorInput {
  /** Deal to evaluate. Required. */
  dealId: string;
  /**
   * Optional scenario override. When omitted the evaluator picks the
   * deal's active scenario (set via {@link FuelDealScenarioRepository.setActive}).
   */
  scenarioId?: string;
}

/** Compliance thresholds the calculator consults. Keep in sync with the
 *  seed defaults — callers that want to tighten / loosen can edit here
 *  without restructuring inputs. */
const DEFAULT_THRESHOLDS = {
  maxPeakCashExposureUsd: 5_000_000,
  minGrossMarginPct: 0.05,
  minNetMarginPerUsg: 0.03,
  maxCounterpartyRiskScore: 65,
  maxCountryRiskScore: 70,
  maxDemurrageDays: 2,
} as const;

const DEFAULT_MONTHLY_OVERHEAD_USD = 120_000;

export class DealEvaluatorAgent implements IAgent {
  readonly name = "deal_evaluator";
  readonly tier = "T1" as const;

  private readonly deals = new FuelDealRepository();
  private readonly scenarios = new FuelDealScenarioRepository();
  private readonly counterparty = new CounterpartyRiskRepository();
  private readonly rates = new FuelMarketRateRepository();

  constructor(private readonly input: DealEvaluatorInput) {}

  async run(ctx: AgentContext): Promise<AgentOutput> {
    // 1. Deal
    const deal = await this.deals.findById(ctx.tx, this.input.dealId);
    if (!deal) {
      return {
        costUsd: 0,
        outputRefs: { skipped: "deal_not_found", deal_id: this.input.dealId },
        proposedActions: [],
        internalWrites: 0,
        rationale: `deal ${this.input.dealId} not in scope`,
      };
    }

    // 2. Scenario (specified id, else active)
    const scenario = this.input.scenarioId
      ? await findScenarioById(ctx.tx, this.input.scenarioId)
      : await this.scenarios.getActiveScenario(ctx.tx, deal.id);
    if (!scenario) {
      return {
        costUsd: 0,
        outputRefs: { skipped: "no_active_scenario", deal_id: deal.id },
        proposedActions: [],
        internalWrites: 0,
        rationale: `deal ${deal.dealRef} has no active scenario to evaluate`,
      };
    }

    // 3. Cost stack (inline — the cost stack repo is not in this
    //    change set, so the agent reads the row directly via drizzle).
    const [costStack] = await ctx.tx
      .select()
      .from(schema.fuelDealCostStack)
      .where(eq(schema.fuelDealCostStack.dealId, deal.id))
      .limit(1);
    if (!costStack) {
      return {
        costUsd: 0,
        outputRefs: { skipped: "no_cost_stack", deal_id: deal.id },
        proposedActions: [],
        internalWrites: 0,
        rationale: `deal ${deal.dealRef} has no cost stack`,
      };
    }

    // 4. Counterparty + latest market rate (latter is informational — the
    //    cost stack already carries the product cost that was locked).
    const cpRisk = await this.counterparty.score(ctx.tx, deal.buyerOrgId);
    const latestRate = await this.rates.getLatest(
      ctx.tx,
      deal.product,
      benchmarkFor(deal.product),
    );

    // 5. Build calculator inputs from persisted rows.
    const inputs = buildInputs({ deal, scenario, costStack });
    const results = calculateFuelDeal(inputs);

    // 6. Persist results on the scenario. Idempotent — rerunning the
    //    same inputs produces the same `results_json`.
    await this.scenarios.saveResults(ctx.tx, scenario.id, results);
    let internalWrites = 1;

    // 7. Compliance hold. Any critical OFAC or BIS warning raises the
    //    hold flag on the deal so downstream tooling can filter out
    //    blocked deals without re-running the calculator.
    const complianceCritical = results.warnings.some(
      (w) =>
        w.severity === "critical" &&
        (w.code.startsWith("ofac.") || w.code.startsWith("bis.")),
    );
    if (complianceCritical && !deal.complianceHold) {
      await ctx.tx
        .update(schema.fuelDeals)
        .set({ complianceHold: true, updatedAt: new Date() })
        .where(eq(schema.fuelDeals.id, deal.id));
      internalWrites++;
    }

    // 8. Summary row — deterministic template, one paragraph.
    const summary = await ctx.summaries.upsert(ctx.tx, ctx.tenantId, {
      subjectType: "fuel_deal",
      subjectId: deal.id,
      summaryType: "deal_evaluation",
      content: buildSummaryText(deal, results, latestRate?.pricePerUsg ?? null),
    });
    internalWrites++;

    // 9. do_not_proceed → propose T2 human-review approval. The
    //    AgentRunner's ApprovalGate will actually create the row.
    const proposedActions: ProposedAction[] = [];
    if (results.scorecard.recommendation === "do_not_proceed") {
      proposedActions.push({
        kind: "deal.human_review",
        tier: "T2",
        payload: {
          deal_id: deal.id,
          deal_ref: deal.dealRef,
          score: results.scorecard.overallScore,
          recommendation: results.scorecard.recommendation,
          reason: results.scorecard.recommendationReason,
          critical_warnings: results.warnings
            .filter((w) => w.severity === "critical")
            .map((w) => ({ code: w.code, message: w.message })),
          subject_id: deal.id,
        },
        rationale: `Deal ${deal.dealRef} requires human review: ${results.scorecard.recommendationReason}`,
      });
    }

    // 10. Audit event — idempotency key tied to (deal, scenario,
    //     agentRunId) so re-runs emit once per run but never duplicate.
    await ctx.events.insertIfNotExists(ctx.tx, ctx.tenantId, {
      verb: "deal.evaluated",
      subjectType: "fuel_deal",
      subjectId: deal.id,
      actorType: "system",
      actorId: this.name,
      objectType: "fuel_deal_scenario",
      objectId: scenario.id,
      occurredAt: new Date(),
      idempotencyKey: `deal.evaluated:${deal.id}:${scenario.id}:${ctx.agentRunId}`,
      metadata: {
        deal_ref: deal.dealRef,
        score: results.scorecard.overallScore,
        recommendation: results.scorecard.recommendation,
        warnings_critical: results.warnings.filter((w) => w.severity === "critical").length,
        warnings_caution: results.warnings.filter((w) => w.severity === "caution").length,
        compliance_hold: complianceCritical,
        counterparty_score: cpRisk?.compositeScore ?? null,
        audit_event_id: createId(),
      },
    });

    // 11. CostLedger — the calculator is deterministic (no LLM) so the
    //     chargeable cost is zero. We still record a zero-cost entry so
    //     the ledger reflects every agent run for reconciliation.
    await ctx.costLedger.record({
      idempotencyKey: `deal_evaluator:${ctx.agentRunId}`,
      tenantId: TenantId(ctx.tenantId),
      operation: "llm.completion",
      provider: "vex.calculator",
      model: "fuel_deal_calculator.v1",
      units: 0,
      unitKind: "computations",
      costUsdMicros: 0,
      occurredAt: new Date(),
    });

    return {
      costUsd: 0,
      outputRefs: {
        deal_id: deal.id,
        deal_ref: deal.dealRef,
        scenario_id: scenario.id,
        summary_id: summary.id,
        score: results.scorecard.overallScore,
        recommendation: results.scorecard.recommendation,
        warnings_total: results.warnings.length,
        compliance_hold: complianceCritical,
      },
      proposedActions,
      internalWrites,
      rationale: `${deal.dealRef}: ${results.scorecard.recommendation} (${results.scorecard.overallScore.toFixed(1)})`,
    };
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function findScenarioById(
  tx: Tx,
  scenarioId: string,
): Promise<FuelDealScenario | null> {
  const [row] = await tx
    .select()
    .from(schema.fuelDealScenarios)
    .where(eq(schema.fuelDealScenarios.id, scenarioId))
    .limit(1);
  return row ?? null;
}

function benchmarkFor(product: string): string {
  if (product.startsWith("jet_")) return "platts_usgc_jet";
  if (product === "ulsd") return "platts_usgc_ulsd";
  return `platts_usgc_${product}`;
}

interface BuildInputsArgs {
  deal: FuelDeal;
  scenario: FuelDealScenario;
  costStack: typeof schema.fuelDealCostStack.$inferSelect;
}

/**
 * Reconstruct FuelDealInputs from persisted rows. Scenario overrides win
 * over deal / cost-stack values when set.
 */
function buildInputs({
  deal,
  scenario,
  costStack,
}: BuildInputsArgs): FuelDealInputs {
  const volumeUsg = scenario.volumeUsgOverride ?? deal.volumeUsg;
  const productCostPerUsg =
    scenario.productCostOverride ?? costStack.productCostPerUsg;
  const freightPerUsg =
    scenario.freightOverridePerUsg ?? costStack.freightRatePerUsg;
  const fxRateToUsd = scenario.fxRateOverride ?? deal.fxRateToUsd;

  const compliance: DealComplianceState = {
    ofac: deal.ofacScreeningStatus,
    bisRequired: deal.bisLicenseRequired,
    bisIssued: deal.bisLicenseNumber !== null,
    eeiRequired: deal.eeiFilingRequired,
    eeiFiled: deal.eeiItn !== null,
  };

  const inputs: FuelDealInputs = {
    dealRef: deal.dealRef,
    product: deal.product,
    incoterm: deal.incoterm,
    volumeUsg,
    densityKgL: deal.densityKgL,
    volumeTolerancePct: deal.volumeTolerancePct,
    sellPricePerUsg: scenario.sellPricePerUsg,
    buyerCurrencyCode: deal.currency,
    fxRateToUsd,
    fxHedgeInPlace: deal.fxHedgeInPlace,
    productCostPerUsg,
    productQualityPremiumPerUsg: costStack.productQualityPremiumUsg,
    freightPerUsg,
    cargoInsurancePct: costStack.cargoInsurancePct,
    warRiskPremiumPct: costStack.warRiskPremiumPct ?? 0,
    politicalRiskPremiumPct: costStack.politicalRiskPremiumPct ?? 0,
    dischargeHandlingPerUsg: costStack.dischargeHandlingPerUsg,
    compliancePerUsg: costStack.totalCompliancePerUsg,
    tradeFinancePerUsg: costStack.tradeFinancePerUsg,
    intermediaryFeePerUsg: costStack.totalAgentPerUsg,
    vtcVariableOpsPerUsg: costStack.vtcVariableOpsPerUsg,
    overheadAllocationUsd: costStack.overheadAllocationUsd,
    tradeFinance: {
      type: deal.paymentTerms,
      ...(deal.lcValueUsd !== null ? { lcValueUsd: deal.lcValueUsd } : {}),
      ...(deal.lcMarginPct !== null ? { lcMarginPct: deal.lcMarginPct } : {}),
    },
    counterpartyRiskScore: deal.counterpartyRiskScore ?? 0,
    countryRiskScore: deal.countryRiskScore ?? 0,
    thresholds: { ...DEFAULT_THRESHOLDS },
    monthlyFixedOverheadUsd: DEFAULT_MONTHLY_OVERHEAD_USD,
    compliance,
  };

  // Vessel sub-record is only present when the cost stack has the core
  // fields populated. Draft / pre-charter deals leave these null — the
  // calculator then skips the vessel-utilization warning path.
  if (
    costStack.vesselCapacityUsg !== null &&
    costStack.vesselUtilizationPct !== null
  ) {
    inputs.vessel = {
      capacityUsg: costStack.vesselCapacityUsg,
      utilizationPct: costStack.vesselUtilizationPct,
      freightLumpSumUsd: costStack.freightRateRaw,
      demurrageRatePerDay: costStack.demurrageRatePerDay ?? 0,
      demurrageEstimatedDays: costStack.demurrageDaysEstimated ?? 0,
      despatchRatePerDay: costStack.despatchRatePerDay ?? 0,
      portDuesLoadUsd: costStack.portDuesLoadUsd ?? 0,
      portDuesDischargeUsd: costStack.portDuesDischargeUsd ?? 0,
      canalTransitUsd: costStack.canalTransitCostUsd ?? 0,
    };
  }

  return inputs;
}

/**
 * One-paragraph evaluation summary. Deterministic template so re-running
 * the evaluator against unchanged inputs produces identical summary text.
 * Top-3 warnings lead; key metrics tail.
 */
function buildSummaryText(
  deal: FuelDeal,
  results: FuelDealResults,
  latestBenchmarkPrice: number | null,
): string {
  const top3 = rankedWarnings(results.warnings).slice(0, 3);
  const warningsPart =
    top3.length > 0
      ? " Top warnings: " +
        top3.map((w) => `${w.message} (${w.severity})`).join("; ") +
        "."
      : " No warnings.";
  const benchmarkPart =
    latestBenchmarkPrice !== null
      ? ` Latest benchmark $${latestBenchmarkPrice.toFixed(4)}/USG.`
      : "";
  const score = results.scorecard.overallScore.toFixed(1);
  return (
    `${deal.dealRef} (${deal.product.toUpperCase()}, ${(
      deal.volumeUsg / 1_000_000
    ).toFixed(2)}M USG ${deal.incoterm.toUpperCase()} ${deal.destinationPort ?? "destination TBD"}): ` +
    `${results.scorecard.recommendation.replace(/_/g, " ")}. ` +
    `Score ${score}/100. ` +
    `Net margin $${results.perUsg.netMargin.toFixed(4)}/USG, ` +
    `EBITDA $${Math.round(results.totals.ebitdaUsd).toLocaleString("en-US")}.` +
    warningsPart +
    benchmarkPart
  );
}

/** Order warnings by severity (critical → caution → info) so the top-3
 *  slice always surfaces the most important items. */
function rankedWarnings(warnings: DealWarning[]): DealWarning[] {
  const rank: Record<DealWarning["severity"], number> = {
    critical: 0,
    caution: 1,
    info: 2,
  };
  return [...warnings].sort((a, b) => rank[a.severity] - rank[b.severity]);
}
