import {
  doublePrecision,
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
} from "drizzle-orm/pg-core";
import { recordStatusEnum } from "./enums.js";

/**
 * Per-field provenance entry. Stored as a map under `field_confidence` on
 * Organizations and Contacts. The `resolveFieldValue()` helper in `merge.ts`
 * consumes these entries plus a workspace-level `source_priority` list to
 * decide whether an incoming value should overwrite the existing one.
 */
export interface FieldConfidenceEntry {
  value: unknown;
  source: string;
  confidence: number;
  updated_at: string;
}

export type FieldConfidenceMap = Record<string, FieldConfidenceEntry>;
export type ExternalKeys = Record<string, string>;

export const organizations = pgTable(
  "organizations",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id").notNull(),
    legalName: text("legal_name").notNull(),
    domain: text("domain"),
    industry: text("industry"),
    geo: jsonb("geo").$type<Record<string, unknown>>(),
    fitScore: doublePrecision("fit_score"),
    sourceOfTruth: text("source_of_truth"),
    externalKeys: jsonb("external_keys").$type<ExternalKeys>().notNull().default({}),
    fieldConfidence: jsonb("field_confidence")
      .$type<FieldConfidenceMap>()
      .notNull()
      .default({}),
    status: recordStatusEnum("status").notNull().default("active"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    tenantIdx: index("organizations_tenant_idx").on(t.tenantId),
    statusIdx: index("organizations_status_idx").on(t.status),
    domainIdx: index("organizations_domain_idx").on(t.domain),
  }),
);

export type Organization = typeof organizations.$inferSelect;
export type NewOrganization = typeof organizations.$inferInsert;
