import {
  boolean,
  date,
  doublePrecision,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { vesselClassEnum } from "./enums.js";
import { organizations } from "./organizations.js";

/**
 * Vessels — the physical hull every fuel deal rides on.
 *
 * Most fields are nullable because vessel particulars trickle in over
 * the life of a charter discussion: the IMO + name come first (often
 * from a broker circular), DWT / draft / class follow when the Q88
 * lands, PSC inspection state arrives only when vetting runs.
 *
 * IMO uniqueness is per-tenant + partial (so rows without an IMO
 * don't collide on NULL). See 0019_vessels for the migration.
 */
export const vessels = pgTable(
  "vessels",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id").notNull(),
    /** IMO 7-digit identity. Null until disclosed. */
    imoNumber: text("imo_number"),
    name: text("name").notNull(),
    /** ISO 3166-1 alpha-2 country code for the flag of registration. */
    flag: text("flag"),
    vesselClass: vesselClassEnum("vessel_class").notNull(),
    dwtMt: doublePrecision("dwt_mt"),
    loaM: doublePrecision("loa_m"),
    beamM: doublePrecision("beam_m"),
    /** Loaded-condition draft. */
    maxDraftM: doublePrecision("max_draft_m"),
    builtYear: integer("built_year"),
    operatorOrgId: text("operator_org_id").references(() => organizations.id, {
      onDelete: "set null",
    }),
    iceClass: text("ice_class"),
    doubleHull: boolean("double_hull").default(true),
    lastPscInspectionDate: date("last_psc_inspection_date"),
    lastPscDeficiencies: integer("last_psc_deficiencies"),
    notes: text("notes"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    tenantIdx: index("vessels_tenant_idx").on(t.tenantId),
    classIdx: index("vessels_class_idx").on(t.tenantId, t.vesselClass),
    imoUniq: uniqueIndex("vessels_imo_uniq").on(t.tenantId, t.imoNumber),
  }),
);

export type Vessel = typeof vessels.$inferSelect;
export type NewVessel = typeof vessels.$inferInsert;
