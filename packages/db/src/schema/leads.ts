import { index, jsonb, pgTable, text, timestamp } from "drizzle-orm/pg-core";
import { leadStatusEnum } from "./enums.js";
import { organizations } from "./organizations.js";
import { contacts } from "./contacts.js";
import { users } from "./users.js";
import type { ExternalKeys } from "./organizations.js";

/**
 * Procur sidecar context attached to a lead at push time. Procur PR
 * #316 (2026-Q2) added these as optional metadata fields on the
 * /ingest/procur/leads payload; vex persists the blob verbatim so
 * the lead UI + chat agent can render KYC state, datasheet specs,
 * source documents, market snapshot, and the pushing desk's trading
 * defaults without re-querying procur. Every sub-field is optional —
 * an old-version push lands as `{}`.
 */
export interface LeadProcurMetadata {
  procurApproval?: {
    status:
      | "pending"
      | "kyc_in_progress"
      | "approved_without_kyc"
      | "approved_with_kyc"
      | "rejected"
      | "expired";
    approvedAt?: string | null | undefined;
    expiresAt?: string | null | undefined;
    notes?: string | null | undefined;
  };
  /**
   * ASTM table from a user-uploaded datasheet. Numbers are stored
   * VERBATIM as strings — spec deviations are material and
   * round-tripping through `number` would silently change them.
   */
  productSpecs?: Array<{
    property: string;
    astmMethod?: string | null | undefined;
    units?: string | null | undefined;
    min?: string | null | undefined;
    max?: string | null | undefined;
    typical?: string | null | undefined;
  }>;
  sourceDocuments?: Array<{
    url: string;
    contentType: string;
    filename: string;
  }>;
  marketContext?: {
    benchmarkAsOf?: string | null | undefined;
    brentSpotUsdPerBbl?: number | null | undefined;
    nyhDieselSpotUsdPerGal?: number | null | undefined;
    nyhGasolineSpotUsdPerGal?: number | null | undefined;
  };
  procurTradingDefaults?: {
    defaultSourcingRegion?: string | null | undefined;
    targetGrossMarginPct?: number | null | undefined;
    targetNetMarginPerUsg?: number | null | undefined;
    monthlyFixedOverheadUsdDefault?: number | null | undefined;
  };
  /**
   * Procur work item 3 follow-up (2026-Q3): the WHY behind a push.
   * Operator asks "why this lead?" / "what's the angle?" — vex
   * answers from these fields without round-tripping to procur.
   *
   * - `pushReason`: free-text, one paragraph max. Lead-with-this when
   *    explaining the lead in chat.
   * - `signals`: ordered (most-recent first) list of procurement events
   *    that motivated the push. Surfaced in the evidence pack so the
   *    chat agent can cite them as `[procur]`.
   * - `matchQueue`: how procur's match queue ranked this counterparty
   *    + the reasons. Optional — only present when the lead came from
   *    the match queue (vs a manual operator push).
   * - `ownership`: parent / subsidiary chain (work item 2 — populated
   *    once procur ships ownership graph). Used during OFAC review to
   *    flag transitive sanctions exposure.
   *
   * All fields optional; absent fields render as empty in the evidence
   * pack and the agent falls back to whatever data IS present.
   */
  pushReason?: string | undefined;
  signals?: Array<ProcurSignal> | undefined;
  matchQueue?:
    | {
        score: number;
        reasons: string[];
        relatedOpportunities?: string[] | undefined;
      }
    | undefined;
  ownership?:
    | {
        parents?: Array<ProcurOwnershipEdge> | undefined;
        subsidiaries?: Array<ProcurOwnershipEdge> | undefined;
      }
    | undefined;
}

export interface ProcurSignal {
  kind:
    | "rfq"
    | "tender_award"
    | "vessel_clearance"
    | "customs_event"
    | "news"
    | "other";
  occurredAt: string;
  /** URL, document id, or system reference where this signal was observed. */
  source: string;
  /** Human-readable summary surfaced to operators in chat + the org detail page. */
  narrative: string;
  /** Optional procur-side relevance score in [0, 1]; unscored when absent. */
  weight?: number | undefined;
}

export interface ProcurOwnershipEdge {
  /** Procur's external key for the linked org (companyKey or entitySlug). */
  orgKey: string;
  /** Display name for UI rendering when the linked org isn't yet a vex row. */
  legalName?: string | undefined;
  role?: string | undefined;
  /** Hops between this lead's org and the linked org. 1 = direct parent / sub. */
  distance: number;
}

export const leads = pgTable(
  "leads",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id").notNull(),
    orgId: text("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    contactId: text("contact_id").references(() => contacts.id, { onDelete: "set null" }),
    ownerId: text("owner_id").references(() => users.id, { onDelete: "set null" }),
    status: leadStatusEnum("status").notNull().default("new"),
    stage: text("stage"),
    qualificationSummary: text("qualification_summary"),
    externalKeys: jsonb("external_keys").$type<ExternalKeys>().notNull().default({}),
    /**
     * Snapshot of procur-side context captured at push time. Default
     * `{}` so reads are safe before the column is populated. See
     * {@link LeadProcurMetadata}.
     */
    procurMetadata: jsonb("procur_metadata")
      .$type<LeadProcurMetadata>()
      .notNull()
      .default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    tenantIdx: index("leads_tenant_idx").on(t.tenantId),
    orgIdx: index("leads_org_idx").on(t.orgId),
    contactIdx: index("leads_contact_idx").on(t.contactId),
    statusIdx: index("leads_status_idx").on(t.status),
    // GIN index for external_keys containment — the website-chat
    // normalizer looks up a lead by conversation_id on conversation.ended.
    // See migration 0021.
    externalKeysGinIdx: index("leads_external_keys_gin_idx").using(
      "gin",
      t.externalKeys,
    ),
  }),
);

export type Lead = typeof leads.$inferSelect;
export type NewLead = typeof leads.$inferInsert;
