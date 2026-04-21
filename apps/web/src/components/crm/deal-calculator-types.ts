/**
 * Narrow types mirroring the subset of FuelDealResults the deal-creator
 * dashboard actually renders. We don't import directly from @vex/db —
 * the web bundle shouldn't pull a DB package — so we keep a skeletal
 * copy here that matches the JSON shape POST /deals/calculate returns.
 */

export type DealRecommendation =
  | "strong"
  | "acceptable"
  | "marginal"
  | "do_not_proceed";

export type DealWarningSeverity = "info" | "caution" | "critical";

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

export interface DealTotals {
  revenueUsd: number;
  grossProfitUsd: number;
  grossMarginPct: number;
  ebitdaUsd: number;
  ebitdaMarginPct: number;
  totalVariableCostUsd: number;
}

export interface PerUsgEconomics {
  sellPrice: number;
  totalVariableCost: number;
  grossMargin: number;
  netMargin: number;
}

export interface CashflowResults {
  peakExposureUsd: number;
  peakExposureDay: number;
  finalPositionUsd: number;
  daysToBreakEven: number;
}

export interface SensitivityGrid {
  rowLabels: string[];
  colLabels: string[];
  values: number[][];
  highlightRow: number;
  highlightCol: number;
}

export interface SensitivityOutputs {
  priceVsVolume: SensitivityGrid;
  priceVsFreight: SensitivityGrid;
  utilizationVsMargin: SensitivityGrid;
  productCostVsPrice: SensitivityGrid;
  /** 1-D freight-rate sweep ±20% in 5% steps. Two rows (EBITDA $,
   *  Peak cash $) × 9 cols. highlightCol = 4 (the 0% baseline) when
   *  populated; -1 when no freight axis is set. */
  freightRateSweep: SensitivityGrid;
}

export interface FuelDealResults {
  perUsg: PerUsgEconomics;
  totals: DealTotals;
  warnings: DealWarning[];
  scorecard: DealScorecard;
  cashflow: CashflowResults;
  sensitivity?: SensitivityOutputs;
}

export interface CalculatorResponse {
  results: FuelDealResults;
  missingEconomicsFields: string[];
}

export interface MarketRate {
  rateDate: string;
  product: string;
  benchmark: string;
  pricePerUsg: number;
  pricePerBbl: number;
  pricePerMt: number;
  currency: string;
  source: string;
}

export interface BuyerIntel {
  counterparty: {
    riskTier: string;
    compositeScore: number;
    countryRisk: number;
    paymentHistoryRisk: number;
    creditRisk: number;
    sanctionsExposureRisk: number;
    concentrationRisk: number;
    recommendedPaymentTerms: string | null;
    recommendedMaxExposureUsd: number | null;
    scoredAt: string;
  } | null;
  concentration: {
    buyerShare: number;
    buyerVolumeUsg: number;
    totalOpenVolumeUsg: number;
    openDealCount: number;
  };
}
