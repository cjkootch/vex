/**
 * Fuel deal calculator — pure functions only.
 *
 * No DB calls, no imports from `@vex/db`, no side effects. Every output is
 * a deterministic function of its input. The calculator is colocated with
 * `@vex/db` only so repositories can compose it against scenario rows in a
 * later change set; nothing here reaches for a transaction.
 *
 * Scope in this change set:
 *   - calculateVesselEconomics
 *   - calculateInsuranceCosts
 *   - calculateUnitEconomics
 *   - calculateTotals
 *   - calculateBreakevens
 *   - calculateWarnings
 *   - calculateDealScore
 *   - calculateFuelDeal       (master — composes the above)
 *
 * Cashflow, returns, risk metrics, sensitivity grids, and program
 * economics are out of scope here.
 */

import type {
  IncotermType,
  OfacScreeningStatus,
  PaymentTermsType,
  ProductType,
} from "@vex/domain";
import { usgToBbl, usgToMt } from "@vex/domain";

// ===========================================================================
// Types
// ===========================================================================

export const DealWarningSeverity = {
  Info: "info",
  Caution: "caution",
  Critical: "critical",
} as const;
export type DealWarningSeverity =
  (typeof DealWarningSeverity)[keyof typeof DealWarningSeverity];

export const DealRecommendation = {
  Strong: "strong",
  Acceptable: "acceptable",
  Marginal: "marginal",
  DoNotProceed: "do_not_proceed",
} as const;
export type DealRecommendation =
  (typeof DealRecommendation)[keyof typeof DealRecommendation];

export interface VesselInputs {
  capacityUsg: number;
  utilizationPct: number;
  freightLumpSumUsd: number;
  demurrageRatePerDay: number;
  demurrageEstimatedDays: number;
  despatchRatePerDay: number;
  portDuesLoadUsd: number;
  portDuesDischargeUsd: number;
  canalTransitUsd: number;
}

export interface TradeFinanceInputs {
  type: PaymentTermsType;
  lcValueUsd?: number;
  lcMarginPct?: number;
  lcDiscountFeeUsd?: number;
  bankGuaranteeFeeUsd?: number;
  prepaymentPct?: number;
}

export interface DealThresholds {
  maxPeakCashExposureUsd: number;
  minGrossMarginPct: number;
  minNetMarginPerUsg: number;
  maxCounterpartyRiskScore: number;
  maxCountryRiskScore: number;
  maxDemurrageDays: number;
}

export interface DealComplianceState {
  ofac: OfacScreeningStatus;
  bisRequired: boolean;
  bisIssued: boolean;
  eeiRequired: boolean;
  eeiFiled: boolean;
}

export interface FuelDealInputs {
  // Deal identity
  dealRef: string;
  product: ProductType;
  incoterm: IncotermType;

  // Volume
  volumeUsg: number;
  densityKgL: number;
  volumeTolerancePct: number;

  // Pricing
  sellPricePerUsg: number;
  buyerCurrencyCode: string;
  fxRateToUsd: number;
  fxHedgeInPlace?: boolean;

  // Cost stack — all $/USG unless noted
  productCostPerUsg: number;
  productQualityPremiumPerUsg: number;
  freightPerUsg: number;
  cargoInsurancePct: number;
  warRiskPremiumPct: number;
  politicalRiskPremiumPct: number;
  dischargeHandlingPerUsg: number;
  compliancePerUsg: number;
  tradeFinancePerUsg: number;
  intermediaryFeePerUsg: number;
  vtcVariableOpsPerUsg: number;

  vessel?: VesselInputs;
  overheadAllocationUsd: number;
  tradeFinance: TradeFinanceInputs;
  counterpartyRiskScore: number;
  countryRiskScore: number;

  thresholds: DealThresholds;
  monthlyFixedOverheadUsd: number;

  /** Compliance state. When omitted the compliance gate is skipped. */
  compliance?: DealComplianceState;

  /** Buyer's share of VTC pipeline by value, 0..1. Drives concentration flag. */
  buyerConcentrationShare?: number;
}

export interface VesselEconomics {
  freightPerUsgIfFullLoad: number;
  freightActualPerUsg: number;
  utilizationPremiumPerUsg: number;
  breakEvenUtilizationPct: number;
}

export interface InsuranceCosts {
  cifValueUsd: number;
  cargoInsuranceUsd: number;
  warRiskUsd: number;
  politicalRiskUsd: number;
  totalInsuranceUsd: number;
  totalInsurancePerUsg: number;
}

export interface PerUsgEconomics {
  sellPrice: number;
  productCost: number;
  qualityPremium: number;
  freight: number;
  insurance: number;
  dischargeHandling: number;
  compliance: number;
  tradeFinance: number;
  intermediaryFees: number;
  variableOps: number;
  totalVariableCost: number;
  grossMargin: number;
  overheadAllocation: number;
  netMargin: number;
}

export interface DealTotals {
  revenueUsd: number;
  productCostUsd: number;
  freightUsd: number;
  insuranceUsd: number;
  dischargeHandlingUsd: number;
  complianceUsd: number;
  tradeFinanceUsd: number;
  intermediaryFeesUsd: number;
  variableOpsUsd: number;
  totalVariableCostUsd: number;
  grossProfitUsd: number;
  grossMarginPct: number;
  overheadUsd: number;
  ebitdaUsd: number;
  ebitdaMarginPct: number;
}

export interface BreakevenAnalysis {
  sellPricePerUsg: number;
  volumeUsg: number;
  freightPerUsgMaximum: number;
  productCostMaximum: number;
}

export interface DealWarning {
  code: string;
  severity: DealWarningSeverity;
  message: string;
  affectedField: string;
}

export interface DealScorecard {
  marginScore: number;
  ebitdaScore: number;
  capitalEfficiencyScore: number;
  riskScore: number;
  complianceScore: number;
  overallScore: number;
  recommendation: DealRecommendation;
  recommendationReason: string;
}

export interface FuelDealResults {
  volumeMt: number;
  volumeBbls: number;
  vessel?: VesselEconomics;
  insurance: InsuranceCosts;
  perUsg: PerUsgEconomics;
  totals: DealTotals;
  breakeven: BreakevenAnalysis;
  warnings: DealWarning[];
  scorecard: DealScorecard;
}

// ===========================================================================
// Vessel economics
// ===========================================================================

/**
 * Vessel economics. Returns undefined when no vessel is supplied — the
 * input `freightPerUsg` is then authoritative.
 *
 * Caribbean fuel supply is vessel-driven: at 14% utilization, freight
 * per USG can be 5-7x its full-load equivalent. `utilizationPremiumPerUsg`
 * quantifies that cost so `calculateWarnings` can elevate it to a
 * critical warning below 25% utilization.
 */
export function calculateVesselEconomics(
  inputs: FuelDealInputs,
): VesselEconomics | undefined {
  const v = inputs.vessel;
  if (!v) return undefined;

  const fixedUsd =
    v.portDuesLoadUsd +
    v.portDuesDischargeUsd +
    v.canalTransitUsd +
    v.demurrageRatePerDay * v.demurrageEstimatedDays;

  const totalVesselCost = v.freightLumpSumUsd + fixedUsd;
  const freightPerUsgIfFullLoad =
    v.capacityUsg > 0 ? totalVesselCost / v.capacityUsg : 0;

  const actualVolume = v.capacityUsg * (v.utilizationPct / 100);
  const freightActualPerUsg = actualVolume > 0 ? totalVesselCost / actualVolume : 0;

  const utilizationPremiumPerUsg = freightActualPerUsg - freightPerUsgIfFullLoad;

  // Break-even utilization: how much of the vessel must be filled for
  // this deal to hit the minNetMarginPerUsg threshold, holding the rest
  // of the cost stack constant. The nonFreightCost term includes the
  // C+F-based insurance rate (evaluated at full-load freight for clarity).
  const nonFreightVarPerUsg =
    inputs.productCostPerUsg +
    inputs.productQualityPremiumPerUsg +
    (inputs.cargoInsurancePct +
      inputs.warRiskPremiumPct +
      inputs.politicalRiskPremiumPct) *
      (inputs.productCostPerUsg + freightPerUsgIfFullLoad) *
      1.1 +
    inputs.dischargeHandlingPerUsg +
    inputs.compliancePerUsg +
    inputs.tradeFinancePerUsg +
    inputs.intermediaryFeePerUsg +
    inputs.vtcVariableOpsPerUsg;
  const overheadPerUsg =
    inputs.volumeUsg > 0 ? inputs.overheadAllocationUsd / inputs.volumeUsg : 0;
  const maxFreightPerUsg =
    inputs.sellPricePerUsg -
    nonFreightVarPerUsg -
    overheadPerUsg -
    inputs.thresholds.minNetMarginPerUsg;

  let breakEvenUtilizationPct: number;
  if (maxFreightPerUsg <= 0 || v.capacityUsg <= 0) {
    // No freight budget at all — cannot break even at any utilization.
    breakEvenUtilizationPct = 100;
  } else {
    const requiredVolume = totalVesselCost / maxFreightPerUsg;
    breakEvenUtilizationPct = Math.min(
      100,
      (requiredVolume / v.capacityUsg) * 100,
    );
  }

  return {
    freightPerUsgIfFullLoad,
    freightActualPerUsg,
    utilizationPremiumPerUsg,
    breakEvenUtilizationPct,
  };
}

// ===========================================================================
// Insurance
// ===========================================================================

/**
 * Insurance stack. CIF value = (product cost + freight) * volume * 1.10 —
 * the industry-standard 110% of C+F that cargo policies cover. Cargo, war,
 * and political risk each apply their rates to that CIF base.
 */
export function calculateInsuranceCosts(inputs: FuelDealInputs): InsuranceCosts {
  const cfPerUsg = inputs.productCostPerUsg + inputs.freightPerUsg;
  const cifValueUsd = cfPerUsg * inputs.volumeUsg * 1.1;
  const cargoInsuranceUsd = cifValueUsd * inputs.cargoInsurancePct;
  const warRiskUsd = cifValueUsd * inputs.warRiskPremiumPct;
  const politicalRiskUsd = cifValueUsd * inputs.politicalRiskPremiumPct;
  const totalInsuranceUsd = cargoInsuranceUsd + warRiskUsd + politicalRiskUsd;
  const totalInsurancePerUsg =
    inputs.volumeUsg > 0 ? totalInsuranceUsd / inputs.volumeUsg : 0;

  return {
    cifValueUsd,
    cargoInsuranceUsd,
    warRiskUsd,
    politicalRiskUsd,
    totalInsuranceUsd,
    totalInsurancePerUsg,
  };
}

// ===========================================================================
// Unit economics
// ===========================================================================

/**
 * Per-USG unit economics. Rolls cargo + war + political into one per-USG
 * insurance figure so the waterfall carries a single insurance bar.
 */
export function calculateUnitEconomics(inputs: FuelDealInputs): PerUsgEconomics {
  const insurance = calculateInsuranceCosts(inputs);

  const totalVariableCost =
    inputs.productCostPerUsg +
    inputs.productQualityPremiumPerUsg +
    inputs.freightPerUsg +
    insurance.totalInsurancePerUsg +
    inputs.dischargeHandlingPerUsg +
    inputs.compliancePerUsg +
    inputs.tradeFinancePerUsg +
    inputs.intermediaryFeePerUsg +
    inputs.vtcVariableOpsPerUsg;

  const grossMargin = inputs.sellPricePerUsg - totalVariableCost;
  const overheadAllocation =
    inputs.volumeUsg > 0 ? inputs.overheadAllocationUsd / inputs.volumeUsg : 0;
  const netMargin = grossMargin - overheadAllocation;

  return {
    sellPrice: inputs.sellPricePerUsg,
    productCost: inputs.productCostPerUsg,
    qualityPremium: inputs.productQualityPremiumPerUsg,
    freight: inputs.freightPerUsg,
    insurance: insurance.totalInsurancePerUsg,
    dischargeHandling: inputs.dischargeHandlingPerUsg,
    compliance: inputs.compliancePerUsg,
    tradeFinance: inputs.tradeFinancePerUsg,
    intermediaryFees: inputs.intermediaryFeePerUsg,
    variableOps: inputs.vtcVariableOpsPerUsg,
    totalVariableCost,
    grossMargin,
    overheadAllocation,
    netMargin,
  };
}

// ===========================================================================
// Deal totals (USD)
// ===========================================================================

export function calculateTotals(
  inputs: FuelDealInputs,
  perUsg: PerUsgEconomics,
): DealTotals {
  const v = inputs.volumeUsg;
  const revenueUsd = perUsg.sellPrice * v;
  const productCostUsd = (perUsg.productCost + perUsg.qualityPremium) * v;
  const freightUsd = perUsg.freight * v;
  const insuranceUsd = perUsg.insurance * v;
  const dischargeHandlingUsd = perUsg.dischargeHandling * v;
  const complianceUsd = perUsg.compliance * v;
  const tradeFinanceUsd = perUsg.tradeFinance * v;
  const intermediaryFeesUsd = perUsg.intermediaryFees * v;
  const variableOpsUsd = perUsg.variableOps * v;
  const totalVariableCostUsd = perUsg.totalVariableCost * v;
  const grossProfitUsd = revenueUsd - totalVariableCostUsd;
  const grossMarginPct = revenueUsd > 0 ? grossProfitUsd / revenueUsd : 0;
  const overheadUsd = inputs.overheadAllocationUsd;
  const ebitdaUsd = grossProfitUsd - overheadUsd;
  const ebitdaMarginPct = revenueUsd > 0 ? ebitdaUsd / revenueUsd : 0;

  return {
    revenueUsd,
    productCostUsd,
    freightUsd,
    insuranceUsd,
    dischargeHandlingUsd,
    complianceUsd,
    tradeFinanceUsd,
    intermediaryFeesUsd,
    variableOpsUsd,
    totalVariableCostUsd,
    grossProfitUsd,
    grossMarginPct,
    overheadUsd,
    ebitdaUsd,
    ebitdaMarginPct,
  };
}

// ===========================================================================
// Breakevens
// ===========================================================================

export function calculateBreakevens(
  inputs: FuelDealInputs,
  perUsg: PerUsgEconomics,
): BreakevenAnalysis {
  const sellPricePerUsg = perUsg.totalVariableCost + perUsg.overheadAllocation;

  const volumeUsg =
    perUsg.grossMargin > 0
      ? inputs.overheadAllocationUsd / perUsg.grossMargin
      : Number.POSITIVE_INFINITY;

  const nonFreightCostPerUsg =
    perUsg.totalVariableCost - perUsg.freight + perUsg.overheadAllocation;
  const freightPerUsgMaximum =
    perUsg.sellPrice - nonFreightCostPerUsg - inputs.thresholds.minNetMarginPerUsg;

  const nonProductCostPerUsg =
    perUsg.totalVariableCost - perUsg.productCost + perUsg.overheadAllocation;
  const productCostMaximum =
    perUsg.sellPrice - nonProductCostPerUsg - inputs.thresholds.minNetMarginPerUsg;

  return {
    sellPricePerUsg,
    volumeUsg,
    freightPerUsgMaximum,
    productCostMaximum,
  };
}

// ===========================================================================
// Warnings
// ===========================================================================

/**
 * Build the warning list. Critical warnings are never downgraded —
 * `calculateDealScore` checks for any `critical` entry and forces the
 * recommendation to `do_not_proceed` regardless of other scores.
 *
 * Vessel utilization warnings are graded:
 *   < 25%   critical with explicit $/USG impact
 *   25-50%  caution
 */
export function calculateWarnings(
  inputs: FuelDealInputs,
  perUsg: PerUsgEconomics,
  totals: DealTotals,
  vessel: VesselEconomics | undefined,
): DealWarning[] {
  const warnings: DealWarning[] = [];

  // --- Compliance: always critical ----------------------------------------
  const c = inputs.compliance;
  if (c) {
    if (
      c.ofac !== "cleared" &&
      c.ofac !== "not_started" // not_started is a draft state — flag as caution below
    ) {
      if (c.ofac === "flagged" || c.ofac === "rejected") {
        warnings.push({
          code: "ofac.blocking",
          severity: "critical",
          message: `OFAC screening ${c.ofac} — deal cannot proceed until resolved`,
          affectedField: "compliance.ofac",
        });
      }
    }
    if (c.ofac === "not_started") {
      warnings.push({
        code: "ofac.not_started",
        severity: "critical",
        message: "OFAC screening not started — required before any external commitment",
        affectedField: "compliance.ofac",
      });
    } else if (c.ofac === "in_progress") {
      warnings.push({
        code: "ofac.in_progress",
        severity: "caution",
        message: "OFAC screening in progress — must clear before BL release",
        affectedField: "compliance.ofac",
      });
    }
    if (c.bisRequired && !c.bisIssued) {
      warnings.push({
        code: "bis.missing",
        severity: "critical",
        message: "BIS export licence required but not issued",
        affectedField: "compliance.bis",
      });
    }
    if (c.eeiRequired && !c.eeiFiled) {
      warnings.push({
        code: "eei.missing",
        severity: "caution",
        message: "EEI filing required but not yet submitted",
        affectedField: "compliance.eei",
      });
    }
  }

  // --- Margins -------------------------------------------------------------
  if (perUsg.netMargin < 0) {
    warnings.push({
      code: "margin.negative_net",
      severity: "critical",
      message: `Selling below breakeven (net margin ${fmtMoneyPerUsg(perUsg.netMargin)}/USG)`,
      affectedField: "sellPricePerUsg",
    });
  }
  if (totals.grossMarginPct < inputs.thresholds.minGrossMarginPct) {
    warnings.push({
      code: "margin.gross_below_threshold",
      severity: "caution",
      message: `Gross margin ${(totals.grossMarginPct * 100).toFixed(2)}% below threshold ${(
        inputs.thresholds.minGrossMarginPct * 100
      ).toFixed(2)}%`,
      affectedField: "grossMarginPct",
    });
  }
  if (
    perUsg.netMargin >= 0 &&
    perUsg.netMargin < inputs.thresholds.minNetMarginPerUsg
  ) {
    warnings.push({
      code: "margin.net_below_threshold",
      severity: "caution",
      message: `Net margin ${fmtMoneyPerUsg(perUsg.netMargin)}/USG below threshold ${fmtMoneyPerUsg(
        inputs.thresholds.minNetMarginPerUsg,
      )}/USG`,
      affectedField: "netMargin",
    });
  }

  // Margin of safety (thin)
  const breakeven = perUsg.totalVariableCost + perUsg.overheadAllocation;
  const marginOfSafety =
    perUsg.sellPrice > 0 ? (perUsg.sellPrice - breakeven) / perUsg.sellPrice : 0;
  if (perUsg.netMargin >= 0 && marginOfSafety < 0.05) {
    warnings.push({
      code: "margin.thin_safety",
      severity: "info",
      message: `Margin of safety ${(marginOfSafety * 100).toFixed(1)}% — thin`,
      affectedField: "netMargin",
    });
  }

  // --- Counterparty / country risk ----------------------------------------
  if (inputs.counterpartyRiskScore > inputs.thresholds.maxCounterpartyRiskScore) {
    warnings.push({
      code: "risk.counterparty",
      severity: "critical",
      message: `Counterparty risk ${inputs.counterpartyRiskScore.toFixed(0)} exceeds max ${inputs.thresholds.maxCounterpartyRiskScore.toFixed(
        0,
      )}`,
      affectedField: "counterpartyRiskScore",
    });
  }
  if (inputs.countryRiskScore > inputs.thresholds.maxCountryRiskScore) {
    warnings.push({
      code: "risk.country",
      severity: "critical",
      message: `Country risk ${inputs.countryRiskScore.toFixed(0)} exceeds max ${inputs.thresholds.maxCountryRiskScore.toFixed(
        0,
      )}`,
      affectedField: "countryRiskScore",
    });
  }

  // --- Vessel utilization -------------------------------------------------
  if (vessel && inputs.vessel) {
    const util = inputs.vessel.utilizationPct;
    if (util < 25) {
      warnings.push({
        code: "vessel.utilization_critical",
        severity: "critical",
        message: `Vessel utilization ${util.toFixed(1)}% — freight penalty ${fmtMoneyPerUsg(
          vessel.utilizationPremiumPerUsg,
        )}/USG vs full load. This is the dominant cost in Caribbean fuel supply; the deal will not work at this level.`,
        affectedField: "vessel.utilizationPct",
      });
    } else if (util < 50) {
      warnings.push({
        code: "vessel.utilization_low",
        severity: "caution",
        message: `Vessel utilization ${util.toFixed(1)}% — freight penalty ${fmtMoneyPerUsg(
          vessel.utilizationPremiumPerUsg,
        )}/USG vs full load`,
        affectedField: "vessel.utilizationPct",
      });
    }

    if (
      inputs.vessel.demurrageEstimatedDays > inputs.thresholds.maxDemurrageDays
    ) {
      warnings.push({
        code: "vessel.demurrage_days",
        severity: "caution",
        message: `Estimated demurrage ${inputs.vessel.demurrageEstimatedDays.toFixed(
          1,
        )} days exceeds threshold ${inputs.thresholds.maxDemurrageDays.toFixed(1)}`,
        affectedField: "vessel.demurrageEstimatedDays",
      });
    }
  }

  // --- FX exposure (informational — never blocks a deal) ------------------
  if (
    inputs.fxRateToUsd !== 1 &&
    !inputs.fxHedgeInPlace &&
    totals.revenueUsd > 500_000
  ) {
    warnings.push({
      code: "fx.unhedged",
      severity: "caution",
      message: `Non-USD deal ${fmtMoney(totals.revenueUsd)} with no FX hedge — 5% adverse move = ${fmtMoney(
        totals.revenueUsd * 0.05,
      )}`,
      affectedField: "fxHedgeInPlace",
    });
  }

  // --- Trade finance terms mismatch ---------------------------------------
  if (
    inputs.tradeFinance.type === "open_account" &&
    inputs.countryRiskScore > 40
  ) {
    warnings.push({
      code: "finance.open_account_high_country_risk",
      severity: "caution",
      message: `Open-account terms with country risk ${inputs.countryRiskScore.toFixed(
        0,
      )} — payment terms do not match risk tier`,
      affectedField: "tradeFinance.type",
    });
  }

  // --- Concentration -------------------------------------------------------
  if (
    inputs.buyerConcentrationShare !== undefined &&
    inputs.buyerConcentrationShare > 0.4
  ) {
    warnings.push({
      code: "risk.concentration",
      severity: "caution",
      message: `Buyer is ${(inputs.buyerConcentrationShare * 100).toFixed(
        1,
      )}% of pipeline — concentration risk`,
      affectedField: "buyerConcentrationShare",
    });
  }

  return warnings;
}

// ===========================================================================
// Scorecard
// ===========================================================================

/**
 * Five-dimensional scorecard. Each dimension is 0-100; the weighted overall
 * is capped at 100. Any CRITICAL warning forces the recommendation to
 * `do_not_proceed` regardless of the numeric score.
 *
 * Weights reproduce the canonical 25/20/20/20/15 split used elsewhere in
 * Vex; in this narrowed calculator `ebitdaScore` substitutes for the full
 * ROI dimension (which needs cashflow) and `capitalEfficiencyScore`
 * substitutes for the peak-cash-exposure dimension, using revenue-per-
 * variable-cost as a proxy.
 */
export function calculateDealScore(
  totals: DealTotals,
  perUsg: PerUsgEconomics,
  warnings: DealWarning[],
  compliance?: DealComplianceState,
): DealScorecard {
  // Margin score — driven by net margin per USG.
  let marginScore: number;
  if (perUsg.netMargin >= 0.1) marginScore = 100;
  else if (perUsg.netMargin >= 0.05) marginScore = 75;
  else if (perUsg.netMargin >= 0.03) marginScore = 50;
  else if (perUsg.netMargin >= 0.01) marginScore = 25;
  else marginScore = 0;

  // EBITDA score — proxy for ROI in the narrowed calculator.
  let ebitdaScore: number;
  const em = totals.ebitdaMarginPct;
  if (em >= 0.08) ebitdaScore = 100;
  else if (em >= 0.05) ebitdaScore = 80;
  else if (em >= 0.03) ebitdaScore = 60;
  else if (em >= 0.01) ebitdaScore = 40;
  else ebitdaScore = 20;

  // Capital efficiency — revenue per dollar of total variable cost. Higher
  // = less capital tied up per unit of revenue. Proxy for cash score.
  const capitalTurnover =
    totals.totalVariableCostUsd > 0
      ? totals.revenueUsd / totals.totalVariableCostUsd
      : 0;
  let capitalEfficiencyScore: number;
  if (capitalTurnover >= 1.15) capitalEfficiencyScore = 100;
  else if (capitalTurnover >= 1.1) capitalEfficiencyScore = 75;
  else if (capitalTurnover >= 1.05) capitalEfficiencyScore = 50;
  else if (capitalTurnover >= 1.02) capitalEfficiencyScore = 25;
  else capitalEfficiencyScore = 0;

  // Risk score — deductions from warnings. Critical warnings zero it out.
  const hasCritical = warnings.some((w) => w.severity === "critical");
  const cautionCount = warnings.filter((w) => w.severity === "caution").length;
  let riskScore: number;
  if (hasCritical) riskScore = 0;
  else riskScore = Math.max(0, 100 - cautionCount * 15);

  // Compliance score.
  let complianceScore: number;
  if (!compliance) {
    complianceScore = 50; // unknown state — neither pass nor block
  } else if (compliance.ofac === "cleared") {
    if (compliance.bisRequired && !compliance.bisIssued) {
      complianceScore = 25;
    } else if (
      !compliance.bisRequired ||
      (compliance.bisIssued &&
        (!compliance.eeiRequired || compliance.eeiFiled))
    ) {
      complianceScore = 100;
    } else {
      complianceScore = 85;
    }
  } else if (compliance.ofac === "in_progress") {
    complianceScore = 50;
  } else if (compliance.ofac === "not_started") {
    complianceScore = 0;
  } else {
    // flagged / rejected
    complianceScore = 0;
  }

  const overallScore = clamp(
    marginScore * 0.25 +
      ebitdaScore * 0.2 +
      capitalEfficiencyScore * 0.2 +
      riskScore * 0.2 +
      complianceScore * 0.15,
    0,
    100,
  );

  let recommendation: DealRecommendation;
  let recommendationReason: string;
  if (hasCritical) {
    recommendation = "do_not_proceed";
    const first = warnings.find((w) => w.severity === "critical")!;
    recommendationReason = `Critical: ${first.message}`;
  } else if (overallScore >= 80) {
    recommendation = "strong";
    recommendationReason = `Score ${overallScore.toFixed(0)} with no critical warnings`;
  } else if (overallScore >= 60) {
    recommendation = "acceptable";
    recommendationReason = `Score ${overallScore.toFixed(0)} — acceptable, monitor ${cautionCount} caution${
      cautionCount === 1 ? "" : "s"
    }`;
  } else if (overallScore >= 40) {
    recommendation = "marginal";
    recommendationReason = `Score ${overallScore.toFixed(0)} — marginal, improvement needed`;
  } else {
    recommendation = "do_not_proceed";
    recommendationReason = `Score ${overallScore.toFixed(0)} — below acceptable threshold`;
  }

  return {
    marginScore,
    ebitdaScore,
    capitalEfficiencyScore,
    riskScore,
    complianceScore,
    overallScore,
    recommendation,
    recommendationReason,
  };
}

// ===========================================================================
// Master — calculateFuelDeal
// ===========================================================================

/**
 * Master function. Composes every step in the right order so callers get a
 * single deterministic FuelDealResults per FuelDealInputs.
 */
export function calculateFuelDeal(inputs: FuelDealInputs): FuelDealResults {
  const vessel = calculateVesselEconomics(inputs);
  const insurance = calculateInsuranceCosts(inputs);
  const perUsg = calculateUnitEconomics(inputs);
  const totals = calculateTotals(inputs, perUsg);
  const breakeven = calculateBreakevens(inputs, perUsg);
  const warnings = calculateWarnings(inputs, perUsg, totals, vessel);
  const scorecard = calculateDealScore(
    totals,
    perUsg,
    warnings,
    inputs.compliance,
  );

  return {
    volumeMt: usgToMt(inputs.volumeUsg, inputs.densityKgL),
    volumeBbls: usgToBbl(inputs.volumeUsg),
    ...(vessel !== undefined ? { vessel } : {}),
    insurance,
    perUsg,
    totals,
    breakeven,
    warnings,
    scorecard,
  };
}

// ===========================================================================
// Local helpers
// ===========================================================================

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

function fmtMoneyPerUsg(n: number): string {
  return `$${n.toFixed(4)}`;
}

function fmtMoney(n: number): string {
  return `$${Math.round(n).toLocaleString("en-US")}`;
}
