import {
  boolean,
  doublePrecision,
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { organizations } from "./organizations.js";

/**
 * Port intelligence dimension (0020_ports).
 *
 * Promotes ports from free-text `origin_port` / `destination_port`
 * strings on fuel_deals to a real entity with physical specs
 * (draft, LOA, beam, DWT), terminal capabilities, timing baselines,
 * and a local-agent FK. The deal evaluator joins against this table
 * to run draft/LOA/reefer-capability checks at the port constraint
 * layer (see calculator validatePortConstraints).
 *
 * Region slugs match the freight_rates vocabulary ("caribbean",
 * "usgc", "ecca") so a deal can trace port → lane → freight
 * benchmark without a translation table.
 */
export const ports = pgTable(
  "ports",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id").notNull(),
    /** UN/LOCODE — 5 chars, country (2) + locode (3). */
    unlocode: text("unlocode").notNull(),
    name: text("name").notNull(),
    /** ISO 3166-1 alpha-2 country code. */
    countryCode: text("country_code").notNull(),
    /** Free-text region slug. See migration for the conventions. */
    region: text("region").notNull(),
    lat: doublePrecision("lat"),
    lng: doublePrecision("lng"),

    // Physical constraints — nullable because particulars trickle in
    // over time as port circulars / Q88-equivalents land.
    maxDraftM: doublePrecision("max_draft_m"),
    maxLoaM: doublePrecision("max_loa_m"),
    maxBeamM: doublePrecision("max_beam_m"),
    maxDwtMt: doublePrecision("max_dwt_mt"),

    // Terminal capabilities — each independent; most ports handle
    // multiple cargo types.
    fuelTerminal: boolean("fuel_terminal").notNull().default(false),
    containerTerminal: boolean("container_terminal").notNull().default(false),
    bulkTerminal: boolean("bulk_terminal").notNull().default(false),
    reeferCapable: boolean("reefer_capable").notNull().default(false),

    // Timing baselines (medians from VTC operational history).
    customsClearanceDaysMedian: doublePrecision(
      "customs_clearance_days_median",
    ),
    portDaysMedian: doublePrecision("port_days_median"),
    /**
     * Multiplier on base days. 1.0 = nominal; >1 = congested. The
     * port-intelligence agent updates this from port-event flow.
     */
    congestionFactor: doublePrecision("congestion_factor").default(1.0),

    tariffNotes: text("tariff_notes"),
    restrictedCargoNotes: text("restricted_cargo_notes"),
    workingHours: text("working_hours"),
    pilotageRequired: boolean("pilotage_required").notNull().default(true),

    /** Linked local agent organization. */
    localAgentOrgId: text("local_agent_org_id").references(
      () => organizations.id,
      { onDelete: "set null" },
    ),

    lastVerifiedAt: timestamp("last_verified_at", { withTimezone: true }),
    /** Audit trail of source URLs / circulars that informed the row. */
    sourceReferences: jsonb("source_references")
      .$type<Array<string | Record<string, unknown>>>()
      .notNull()
      .default([]),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    tenantIdx: index("ports_tenant_idx").on(t.tenantId),
    regionIdx: index("ports_region_idx").on(t.tenantId, t.region),
    countryIdx: index("ports_country_idx").on(t.tenantId, t.countryCode),
    unlocodeUniq: uniqueIndex("ports_unlocode_uniq").on(
      t.tenantId,
      t.unlocode,
    ),
  }),
);

export type Port = typeof ports.$inferSelect;
export type NewPort = typeof ports.$inferInsert;
