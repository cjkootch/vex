import {
  boolean,
  doublePrecision,
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
} from "drizzle-orm/pg-core";
import { scenarioTypeEnum } from "./enums.js";
import { fuelDeals } from "./fuel-deals.js";

/**
 * Scenario versions of a deal. The `is_active` scenario is the one the
 * evaluator treats as canonical; overrides are resolved against the base
 * deal (null = use base value). `results_json` is kept as opaque JSONB at
 * the schema layer — a calculator lands in a later change set and will
 * define the shape it writes.
 */
export const fuelDealScenarios = pgTable(
  "fuel_deal_scenarios",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id").notNull(),
    dealId: text("deal_id")
      .notNull()
      .references(() => fuelDeals.id, { onDelete: "cascade" }),
    scenarioName: text("scenario_name").notNull(),
    scenarioType: scenarioTypeEnum("scenario_type").notNull().default("base"),
    isActive: boolean("is_active").notNull().default(false),

    volumeUsgOverride: doublePrecision("volume_usg_override"),
    sellPricePerUsg: doublePrecision("sell_price_per_usg").notNull(),
    productCostOverride: doublePrecision("product_cost_override"),
    freightOverridePerUsg: doublePrecision("freight_override_per_usg"),
    fxRateOverride: doublePrecision("fx_rate_override"),
    demurrageDaysOverride: doublePrecision("demurrage_days_override"),
    storageDaysOverride: doublePrecision("storage_days_override"),

    resultsJson: jsonb("results_json").$type<Record<string, unknown> | null>(),
    score: doublePrecision("score"),
    recommendation: text("recommendation"),
    calculatedAt: timestamp("calculated_at", { withTimezone: true }),

    notes: text("notes"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    tenantIdx: index("fuel_deal_scenarios_tenant_idx").on(t.tenantId),
    dealIdx: index("fuel_deal_scenarios_deal_idx").on(t.dealId),
    activeIdx: index("fuel_deal_scenarios_active_idx").on(t.dealId, t.isActive),
  }),
);

export type FuelDealScenario = typeof fuelDealScenarios.$inferSelect;
export type NewFuelDealScenario = typeof fuelDealScenarios.$inferInsert;
