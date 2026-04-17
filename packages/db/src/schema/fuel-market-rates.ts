import {
  date,
  doublePrecision,
  index,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";

/**
 * Reference rates for pricing and benchmarking. Populated by a market-data
 * ingestion agent (not yet implemented as a live feed — seeded with static
 * rates for now). All three per-unit prices are stored so downstream
 * consumers don't have to re-derive.
 *
 * Unique per (tenant, date, product, benchmark) so idempotent re-ingest is
 * safe.
 */
export const fuelMarketRates = pgTable(
  "fuel_market_rates",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id").notNull(),
    rateDate: date("rate_date").notNull(),
    product: text("product").notNull(),
    benchmark: text("benchmark").notNull(),
    pricePerUsg: doublePrecision("price_per_usg").notNull(),
    pricePerBbl: doublePrecision("price_per_bbl").notNull(),
    pricePerMt: doublePrecision("price_per_mt").notNull(),
    currency: text("currency").notNull().default("usd"),
    source: text("source").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    tenantIdx: index("fuel_market_rates_tenant_idx").on(t.tenantId),
    productBenchmarkIdx: index("fuel_market_rates_product_benchmark_idx").on(
      t.product,
      t.benchmark,
    ),
    dateIdx: index("fuel_market_rates_date_idx").on(t.rateDate),
    uniqPerDay: uniqueIndex("fuel_market_rates_uniq_per_day").on(
      t.tenantId,
      t.rateDate,
      t.product,
      t.benchmark,
    ),
  }),
);

export type FuelMarketRate = typeof fuelMarketRates.$inferSelect;
export type NewFuelMarketRate = typeof fuelMarketRates.$inferInsert;
