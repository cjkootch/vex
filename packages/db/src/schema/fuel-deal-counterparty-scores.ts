import {
  doublePrecision,
  index,
  pgTable,
  text,
  timestamp,
} from "drizzle-orm/pg-core";
import { counterpartyRiskTierEnum } from "./enums.js";
import { organizations } from "./organizations.js";
import { users } from "./users.js";

/**
 * Structured counterparty risk assessment. Each dimension is 0-100 with
 * higher = riskier. `composite_score` is a weighted average the scorer
 * computes; the tier + recommended terms are human judgment columns
 * stored alongside so downstream deals don't have to re-derive.
 */
export const fuelDealCounterpartyScores = pgTable(
  "fuel_deal_counterparty_scores",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id").notNull(),
    orgId: text("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    scoredAt: timestamp("scored_at", { withTimezone: true }).notNull().defaultNow(),
    scoredBy: text("scored_by").references(() => users.id, { onDelete: "set null" }),

    countryRisk: doublePrecision("country_risk").notNull(),
    paymentHistoryRisk: doublePrecision("payment_history_risk").notNull(),
    creditRisk: doublePrecision("credit_risk").notNull(),
    sanctionsExposureRisk: doublePrecision("sanctions_exposure_risk").notNull(),
    ownershipTransparencyRisk: doublePrecision("ownership_transparency_risk").notNull(),
    regulatoryComplexityRisk: doublePrecision("regulatory_complexity_risk").notNull(),
    operationalRisk: doublePrecision("operational_risk").notNull(),
    concentrationRisk: doublePrecision("concentration_risk").notNull(),

    compositeScore: doublePrecision("composite_score").notNull(),
    riskTier: counterpartyRiskTierEnum("risk_tier").notNull(),
    recommendedPaymentTerms: text("recommended_payment_terms"),
    recommendedMaxExposureUsd: doublePrecision("recommended_max_exposure_usd"),
    notes: text("notes"),
  },
  (t) => ({
    tenantIdx: index("fuel_deal_counterparty_scores_tenant_idx").on(t.tenantId),
    orgIdx: index("fuel_deal_counterparty_scores_org_idx").on(t.orgId),
    tierIdx: index("fuel_deal_counterparty_scores_tier_idx").on(t.riskTier),
  }),
);

export type FuelDealCounterpartyScore =
  typeof fuelDealCounterpartyScores.$inferSelect;
export type NewFuelDealCounterpartyScore =
  typeof fuelDealCounterpartyScores.$inferInsert;
