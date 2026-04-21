import {
  date,
  doublePrecision,
  index,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { vesselClassEnum } from "./enums.js";

/**
 * Freight rates — time series of market benchmarks keyed on
 * (origin, destination, vessel_class, product_category, source).
 * Populated from Baltic / Platts / broker circulars / manual entries
 * and consumed by the deal evaluator to mark-to-market every locked
 * freight rate (deal.freight_rate_usd_per_mt vs the market on the
 * lock date).
 *
 * Region slugs (origin/destination) are free text — "USGC", "Caribs",
 * "ECCA", "Med" — so new lanes can be added without a schema bump.
 * `product_category` is text for the same reason.
 */
export const freightRates = pgTable(
  "freight_rates",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id").notNull(),
    rateDate: date("rate_date").notNull(),
    originRegion: text("origin_region").notNull(),
    destinationRegion: text("destination_region").notNull(),
    vesselClass: vesselClassEnum("vessel_class").notNull(),
    /** "clean_products", "dirty", "dry_bulk", etc. */
    productCategory: text("product_category").notNull(),
    rateUsdPerMt: doublePrecision("rate_usd_per_mt").notNull(),
    /** Worldscale points for tanker voyage charters; null when the
     *  source quotes a fixed $/mt only. */
    worldscalePoints: doublePrecision("worldscale_points"),
    /** "baltic", "platts", "broker_circular", "manual". */
    source: text("source").notNull(),
    sourceReference: text("source_reference"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    tenantIdx: index("freight_rates_tenant_idx").on(t.tenantId),
    routeIdx: index("freight_rates_route_idx").on(
      t.tenantId,
      t.originRegion,
      t.destinationRegion,
      t.vesselClass,
      t.rateDate,
    ),
    /** Idempotent ingest: same publication tuple collapses to one row. */
    uniqRow: uniqueIndex("freight_rates_uniq").on(
      t.tenantId,
      t.rateDate,
      t.originRegion,
      t.destinationRegion,
      t.vesselClass,
      t.productCategory,
      t.source,
    ),
  }),
);

export type FreightRate = typeof freightRates.$inferSelect;
export type NewFreightRate = typeof freightRates.$inferInsert;
