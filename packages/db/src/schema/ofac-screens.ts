import {
  doublePrecision,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
} from "drizzle-orm/pg-core";
import { organizations } from "./organizations.js";
import { users } from "./users.js";

/**
 * Full audit trail of OFAC SDN screens. One row per screen run per
 * organization — never mutated in place, so the compliance timeline is
 * reconstructable without a separate event stream.
 *
 * `matches` is stored as JSONB so the structured `SdnScreenResult` shape
 * (entry UID, matched name, score, programs) travels with the row for
 * audit / reviewer UI consumption. The `cleared_by / cleared_at /
 * cleared_reason` trio is populated only when an operator downgrades a
 * potential_match to cleared_by_operator — that action writes a fresh
 * row rather than patching the original so the review is traceable.
 *
 * Text status field (not enum) so the OFACScreeningAgent can introduce
 * new states without a schema bump.
 */
export const ofacScreens = pgTable(
  "ofac_screens",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id").notNull(),
    orgId: text("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    screenedAt: timestamp("screened_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    /** Calendar date of the SDN XML list used for this screen. */
    sdnListDate: text("sdn_list_date").notNull(),
    /** clear / potential_match / confirmed_match / cleared_by_operator. */
    status: text("status").notNull(),
    highestScore: doublePrecision("highest_score").notNull().default(0),
    matchCount: integer("match_count").notNull().default(0),
    matches: jsonb("matches")
      .$type<OfacMatchRecord[]>()
      .notNull()
      .default([]),
    clearedBy: text("cleared_by").references(() => users.id, {
      onDelete: "set null",
    }),
    clearedAt: timestamp("cleared_at", { withTimezone: true }),
    clearedReason: text("cleared_reason"),
  },
  (t) => ({
    tenantIdx: index("ofac_screens_tenant_idx").on(t.tenantId, t.screenedAt),
    orgIdx: index("ofac_screens_org_idx").on(t.orgId, t.screenedAt),
    statusIdx: index("ofac_screens_status_idx").on(t.tenantId, t.status),
  }),
);

export interface OfacMatchRecord {
  /** OFAC unique identifier of the listing. */
  sdnUid: string;
  /** Legal or alias name on the listing that scored highest. */
  matchedName: string;
  /** 0..1 similarity score. */
  score: number;
  /** exact | fuzzy | alias. */
  matchType: string;
  /** Sanction programs on the listing (e.g. ["CUBA", "SDGT"]). */
  programs: string[];
  /** individual | entity | vessel | aircraft. */
  sdnType: string;
  /**
   * Which list the entry came from. The agent can run against
   * multiple sources in a single pass (US CSL + EU + UK OFSI) and
   * stamps each match with its origin so reviewers triage them
   * differently — a BIS Entity List hit and a UK regime hit warrant
   * very different escalation paths.
   *
   * US CSL codes: `SDN`, `NS-PLC`, `SSI`, `FSE` (Treasury);
   *   `DPL`, `EL`, `UVL`, `MEU` (Commerce / BIS); `DTC`, `ISN`, `CAP`
   *   (State).
   * EU: `EU` (consolidated financial sanctions list).
   * UK: `UK_OFSI` (Office of Financial Sanctions Implementation).
   * Unknown source from a known adapter: `OTHER`.
   *
   * Optional for backward compatibility — historical rows written
   * before CSL ingestion landed are implicitly `SDN` (the legacy
   * adapter's only source). The reviewer UI surfaces this as a chip
   * on each match row so triage stays list-aware.
   */
  sourceList?: string;
}

export type OfacScreen = typeof ofacScreens.$inferSelect;
export type NewOfacScreen = typeof ofacScreens.$inferInsert;
