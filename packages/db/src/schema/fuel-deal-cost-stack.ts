import {
  doublePrecision,
  index,
  pgTable,
  text,
  timestamp,
} from "drizzle-orm/pg-core";
import {
  dealCurrencyEnum,
  freightBasisEnum,
  vesselTypeEnum,
} from "./enums.js";
import { fuelDeals } from "./fuel-deals.js";

/**
 * One row per deal — the full cost build-up. Kept out of `fuel_deals` so
 * the deal record stays compact and so scenarios can copy + override the
 * cost stack without cluttering the deal row.
 *
 * Summary columns (`total_landed_cost_per_usg`, `gross_margin_per_usg`, etc.)
 * are persisted by the calculator's `saveResults` path; they are NOT the
 * source of truth — the scenario's `results_json` is.
 */
export const fuelDealCostStack = pgTable(
  "fuel_deal_cost_stack",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id").notNull(),
    dealId: text("deal_id")
      .notNull()
      .references(() => fuelDeals.id, { onDelete: "cascade" }),

    // PRODUCT
    productCostPerUsg: doublePrecision("product_cost_per_usg").notNull(),
    productQualityPremiumUsg: doublePrecision("product_quality_premium_usg")
      .notNull()
      .default(0),
    productCostBasis: text("product_cost_basis"),

    // VESSEL / FREIGHT
    vesselName: text("vessel_name"),
    vesselImo: text("vessel_imo"),
    vesselFlag: text("vessel_flag"),
    vesselType: vesselTypeEnum("vessel_type"),
    vesselCapacityUsg: doublePrecision("vessel_capacity_usg"),
    vesselUtilizationPct: doublePrecision("vessel_utilization_pct"),
    freightBasis: freightBasisEnum("freight_basis").notNull().default("per_usg"),
    freightRateRaw: doublePrecision("freight_rate_raw").notNull().default(0),
    freightRatePerUsg: doublePrecision("freight_rate_per_usg").notNull().default(0),
    freightCurrency: dealCurrencyEnum("freight_currency").notNull().default("usd"),
    demurrageRatePerDay: doublePrecision("demurrage_rate_per_day"),
    demurrageAllowedHours: doublePrecision("demurrage_allowed_hours"),
    demurrageDaysEstimated: doublePrecision("demurrage_days_estimated"),
    demurrageCostEstimated: doublePrecision("demurrage_cost_estimated"),
    despatchRatePerDay: doublePrecision("despatch_rate_per_day"),
    portDuesLoadUsd: doublePrecision("port_dues_load_usd"),
    portDuesDischargeUsd: doublePrecision("port_dues_discharge_usd"),
    canalTransitCostUsd: doublePrecision("canal_transit_cost_usd"),
    bunkeringCostUsd: doublePrecision("bunkering_cost_usd"),
    freightTotalUsd: doublePrecision("freight_total_usd").notNull().default(0),
    freightPerUsgAllIn: doublePrecision("freight_per_usg_all_in").notNull().default(0),

    // INSURANCE
    cargoInsurancePct: doublePrecision("cargo_insurance_pct").notNull().default(0),
    cargoInsuranceUsd: doublePrecision("cargo_insurance_usd").notNull().default(0),
    warRiskPremiumPct: doublePrecision("war_risk_premium_pct"),
    warRiskUsd: doublePrecision("war_risk_usd"),
    piContributionUsd: doublePrecision("pi_contribution_usd"),
    politicalRiskPremiumPct: doublePrecision("political_risk_premium_pct"),
    politicalRiskUsd: doublePrecision("political_risk_usd"),
    totalInsurancePerUsg: doublePrecision("total_insurance_per_usg").notNull().default(0),

    // PORT / DISCHARGE / HANDLING
    dischargePortFeeUsd: doublePrecision("discharge_port_fee_usd"),
    storageFeePerDayUsd: doublePrecision("storage_fee_per_day_usd"),
    storageDaysEstimated: doublePrecision("storage_days_estimated"),
    storageCostUsd: doublePrecision("storage_cost_usd"),
    customsClearanceUsd: doublePrecision("customs_clearance_usd"),
    inspectionFeeUsd: doublePrecision("inspection_fee_usd"),
    samplingTestingUsd: doublePrecision("sampling_testing_usd"),
    shoreTankRentalUsd: doublePrecision("shore_tank_rental_usd"),
    blendingCostUsd: doublePrecision("blending_cost_usd"),
    dischargeHandlingPerUsg: doublePrecision("discharge_handling_per_usg")
      .notNull()
      .default(0),

    // REGULATORY / COMPLIANCE
    ofacScreeningFeeUsd: doublePrecision("ofac_screening_fee_usd"),
    bisLicenseFeeUsd: doublePrecision("bis_license_fee_usd"),
    eeiFilingFeeUsd: doublePrecision("eei_filing_fee_usd"),
    complianceLegalUsd: doublePrecision("compliance_legal_usd"),
    kycAmlCostUsd: doublePrecision("kyc_aml_cost_usd"),
    sanctionsInsuranceUsd: doublePrecision("sanctions_insurance_usd"),
    totalCompliancePerUsg: doublePrecision("total_compliance_per_usg").notNull().default(0),

    // TRADE FINANCE
    lcFeeUsd: doublePrecision("lc_fee_usd"),
    lcDiscountFeeUsd: doublePrecision("lc_discount_fee_usd"),
    bankGuaranteeFeeUsd: doublePrecision("bank_guarantee_fee_usd"),
    tradeFinanceTotalUsd: doublePrecision("trade_finance_total_usd").notNull().default(0),
    tradeFinancePerUsg: doublePrecision("trade_finance_per_usg").notNull().default(0),

    // AGENT / INTERMEDIARY
    intermediaryFeePct: doublePrecision("intermediary_fee_pct"),
    intermediaryFeeUsd: doublePrecision("intermediary_fee_usd"),
    localAgentFeeUsd: doublePrecision("local_agent_fee_usd"),
    brokeragePct: doublePrecision("brokerage_pct"),
    brokerageUsd: doublePrecision("brokerage_usd"),
    totalAgentPerUsg: doublePrecision("total_agent_per_usg").notNull().default(0),

    // VARIABLE OPS
    vtcVariableOpsPerUsg: doublePrecision("vtc_variable_ops_per_usg").notNull().default(0),

    // OVERHEAD ALLOCATION
    overheadAllocationUsd: doublePrecision("overhead_allocation_usd").notNull().default(0),
    overheadPerUsg: doublePrecision("overhead_per_usg").notNull().default(0),

    // SUMMARY
    totalLandedCostPerUsg: doublePrecision("total_landed_cost_per_usg").notNull().default(0),
    grossMarginPerUsg: doublePrecision("gross_margin_per_usg").notNull().default(0),
    grossMarginPct: doublePrecision("gross_margin_pct").notNull().default(0),
    netMarginPerUsg: doublePrecision("net_margin_per_usg").notNull().default(0),
    netMarginPct: doublePrecision("net_margin_pct").notNull().default(0),
    ebitdaUsd: doublePrecision("ebitda_usd").notNull().default(0),
    breakevenSellPriceUsg: doublePrecision("breakeven_sell_price_usg").notNull().default(0),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    tenantIdx: index("fuel_deal_cost_stack_tenant_idx").on(t.tenantId),
    dealIdx: index("fuel_deal_cost_stack_deal_idx").on(t.dealId),
  }),
);

export type FuelDealCostStack = typeof fuelDealCostStack.$inferSelect;
export type NewFuelDealCostStack = typeof fuelDealCostStack.$inferInsert;
