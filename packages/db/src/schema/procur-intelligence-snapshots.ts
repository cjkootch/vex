import {
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { organizations } from "./organizations.js";

/**
 * Cached procur intelligence per organization × tool × query. Refreshed
 * by ProcurEnrichmentAgent on a TTL (default 7 days from
 * PROCUR_CACHE_TTL_DAYS) or on explicit operator request.
 *
 * Each row carries:
 *   - the procur tool that produced it (analyze_supplier,
 *     analyze_supplier_pricing, find_recent_cargoes, etc.)
 *   - a query hash (input args canonicalised + JSON-stringified) so two
 *     different argument shapes against the same tool produce distinct
 *     snapshots
 *   - the structured response payload, verbatim
 *   - fetchedAt + expiresAt for staleness checks
 *
 * Tenant-scoped despite procur underneath being public-data: vex's
 * tenant boundary is the security model — different vex tenants
 * shouldn't see each other's choice of which orgs they enriched, what
 * args they passed, or when they enriched.
 *
 * Idempotency key on insert is (tenant_id, org_id, procur_tool,
 * query_hash) — re-fetching the same shape upserts in-place.
 */
export const procurIntelligenceSnapshots = pgTable(
  "procur_intelligence_snapshots",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id").notNull(),
    orgId: text("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),

    /** Tool name — `analyze_supplier`, `analyze_supplier_pricing`,
        `find_recent_cargoes`, `analyze_buyer_pricing`,
        `entity_news`, etc. */
    procurTool: text("procur_tool").notNull(),
    /** Canonical hash of the input args. Used to dedupe + index. */
    queryHash: text("query_hash").notNull(),
    /** Procur's response payload, verbatim. */
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),

    fetchedAt: timestamp("fetched_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    /** When this snapshot should be considered stale and re-fetched. */
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  },
  (t) => ({
    tenantIdx: index("procur_snapshots_tenant_idx").on(t.tenantId),
    tenantOrgToolIdx: index("procur_snapshots_tenant_org_tool_idx").on(
      t.tenantId,
      t.orgId,
      t.procurTool,
    ),
    expiresIdx: index("procur_snapshots_expires_idx").on(t.expiresAt),
    /**
     * Logical dedupe key — same tenant + org + tool + args = one row.
     * Re-fetches upsert on this conflict target.
     */
    uniqueKey: uniqueIndex("procur_snapshots_unique_idx").on(
      t.tenantId,
      t.orgId,
      t.procurTool,
      t.queryHash,
    ),
  }),
);

export type ProcurIntelligenceSnapshot =
  typeof procurIntelligenceSnapshots.$inferSelect;
export type NewProcurIntelligenceSnapshot =
  typeof procurIntelligenceSnapshots.$inferInsert;
