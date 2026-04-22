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
    /** Sprint O — free-form tags appended by the chat agent. */
    tags: jsonb("tags").$type<string[]>().notNull().default([]),
    /**
     * Sprint W — counterparty role. One of: buyer, supplier, broker,
     * buyer_broker, internal, competitor. Null for pre-sprint-W rows
     * that haven't been classified yet. Stored as text (not enum) so
     * the vocabulary can evolve without a migration.
     */
    kind: text("kind"),
    /**
     * OFAC SDN screening state (0018_ofac_screening). Distinct from the
     * per-deal `ofac_screening_status` enum on fuel_deals — this is the
     * counterparty-level gate. Text (not enum) so the OFACScreeningAgent
     * can add new states (e.g. "stale") without a schema bump. Allowed
     * values: unscreened, clear, potential_match, confirmed_match,
     * cleared_by_operator. Defaults to 'unscreened' so new counterparties
     * are visibly ungated.
     */
    ofacStatus: text("ofac_status").notNull().default("unscreened"),
    ofacScreenedAt: timestamp("ofac_screened_at", { withTimezone: true }),
    ofacHighestScore: doublePrecision("ofac_highest_score"),
    status: recordStatusEnum("status").notNull().default("active"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    tenantIdx: index("organizations_tenant_idx").on(t.tenantId),
    statusIdx: index("organizations_status_idx").on(t.status),
    domainIdx: index("organizations_domain_idx").on(t.domain),
    // GIN index for external_keys containment lookups (findByExternalKey,
    // upsertByExternalKey). See migration 0021.
    externalKeysGinIdx: index("organizations_external_keys_gin_idx").using(
      "gin",
      t.externalKeys,
    ),
  }),
);

export type Organization = typeof organizations.$inferSelect;
export type NewOrganization = typeof organizations.$inferInsert;
