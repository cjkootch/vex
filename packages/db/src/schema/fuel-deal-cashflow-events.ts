import {
  doublePrecision,
  index,
  integer,
  pgTable,
  text,
  timestamp,
} from "drizzle-orm/pg-core";
import {
  cashflowBaseTypeEnum,
  cashflowDirectionEnum,
  cashflowEventTypeEnum,
} from "./enums.js";
import { fuelDeals } from "./fuel-deals.js";

/**
 * Cashflow schedule for a deal. Event-driven — `day_relative` is relative to
 * the BL date, and exactly one of `amount_pct` / `amount_fixed_usd` is set
 * per event. The calculator resolves both into `amount_calculated_usd`
 * when computing the cumulative-position timeline.
 */
export const fuelDealCashflowEvents = pgTable(
  "fuel_deal_cashflow_events",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id").notNull(),
    dealId: text("deal_id")
      .notNull()
      .references(() => fuelDeals.id, { onDelete: "cascade" }),
    dayRelative: integer("day_relative").notNull(),
    label: text("label").notNull(),
    direction: cashflowDirectionEnum("direction").notNull(),
    eventType: cashflowEventTypeEnum("event_type").notNull(),
    baseType: cashflowBaseTypeEnum("base_type").notNull(),
    amountPct: doublePrecision("amount_pct"),
    amountFixedUsd: doublePrecision("amount_fixed_usd"),
    amountCalculatedUsd: doublePrecision("amount_calculated_usd").notNull().default(0),
    currency: text("currency").notNull().default("usd"),
    fxRate: doublePrecision("fx_rate").notNull().default(1),
    counterparty: text("counterparty"),
    paymentMethod: text("payment_method"),
    notes: text("notes"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    tenantIdx: index("fuel_deal_cashflow_events_tenant_idx").on(t.tenantId),
    dealIdx: index("fuel_deal_cashflow_events_deal_idx").on(t.dealId),
    dealDayIdx: index("fuel_deal_cashflow_events_deal_day_idx").on(
      t.dealId,
      t.dayRelative,
    ),
  }),
);

export type FuelDealCashflowEvent = typeof fuelDealCashflowEvents.$inferSelect;
export type NewFuelDealCashflowEvent = typeof fuelDealCashflowEvents.$inferInsert;
