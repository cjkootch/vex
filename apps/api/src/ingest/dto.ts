import { z } from "zod";

/**
 * Payload schema for `POST /ingest/procur/leads`. Field naming is
 * camelCase on the wire — procur's TypeScript client emits this shape
 * verbatim, no per-field renaming. Mirrors the contract documented in
 * `docs/procur-integration.md` §6.
 *
 * `procurOpportunityId` is the only strictly-required identifier; it
 * doubles as the idempotency key on the lead row's `externalKeys.procur`.
 */

/**
 * Procur PR #316 (2026-Q2): structured sidecar context attached at
 * push time. Every sub-field is optional so old-version pushes keep
 * validating cleanly. The whole blob lands verbatim on
 * `leads.procur_metadata`; vex re-projects what it needs onto the
 * lead UI and the chat agent's evidence pack.
 */
const ProcurApprovalSchema = z.object({
  status: z.enum([
    "pending",
    "kyc_in_progress",
    "approved_without_kyc",
    "approved_with_kyc",
    "rejected",
    "expired",
  ]),
  approvedAt: z.string().nullable().optional(),
  expiresAt: z.string().nullable().optional(),
  notes: z.string().nullable().optional(),
});

const ProductSpecSchema = z.object({
  property: z.string().min(1).max(200),
  // Numbers stored verbatim as strings — spec deviations are
  // material; we don't coerce / round / parse out empty strings.
  astmMethod: z.string().nullable().optional(),
  units: z.string().nullable().optional(),
  min: z.string().nullable().optional(),
  max: z.string().nullable().optional(),
  typical: z.string().nullable().optional(),
});

const SourceDocumentSchema = z.object({
  url: z.string().url(),
  contentType: z.string().min(1).max(120),
  filename: z.string().min(1).max(500),
});

const MarketContextSchema = z.object({
  benchmarkAsOf: z.string().nullable().optional(),
  brentSpotUsdPerBbl: z.number().nullable().optional(),
  nyhDieselSpotUsdPerGal: z.number().nullable().optional(),
  nyhGasolineSpotUsdPerGal: z.number().nullable().optional(),
});

const ProcurTradingDefaultsSchema = z.object({
  defaultSourcingRegion: z.string().nullable().optional(),
  targetGrossMarginPct: z.number().nullable().optional(),
  targetNetMarginPerUsg: z.number().nullable().optional(),
  monthlyFixedOverheadUsdDefault: z.number().nullable().optional(),
});

const ProcurMetadataSchema = z
  .object({
    procurApproval: ProcurApprovalSchema.optional(),
    productSpecs: z.array(ProductSpecSchema).max(200).optional(),
    sourceDocuments: z.array(SourceDocumentSchema).max(50).optional(),
    marketContext: MarketContextSchema.optional(),
    procurTradingDefaults: ProcurTradingDefaultsSchema.optional(),
  })
  // Procur also stamps free-form context (source, sourceRef,
  // triggeredBy, pushedAt, awardCount, …) on the same metadata
  // object. We accept and persist them — even if unmapped today,
  // they end up on the persisted blob for downstream consumers.
  .passthrough();

export const ProcurLeadIngestSchema = z.object({
  procurOpportunityId: z.string().min(1).max(200),
  sourceUrl: z.string().url().optional(),
  title: z.string().min(1).max(500).optional(),
  category: z.string().max(50).optional(),
  buyer: z.object({
    legalName: z.string().min(1).max(500),
    country: z.string().length(2).optional(),
    /**
     * Procur-side stable identifier — used as the org's
     * `externalKeys.procur` so future enrichment calls hit the same
     * row. Optional because procur may push a buyer it hasn't fully
     * profiled yet; we fall back to normalized-identity dedupe.
     */
    entitySlug: z.string().min(1).max(200).optional(),
    domain: z.string().max(200).optional(),
    /**
     * Deep-link back to the entity's procur profile. Optional;
     * surfaced on the lead UI when present.
     */
    procurEntityProfileUrl: z.string().url().optional(),
  }),
  contacts: z
    .array(
      z.object({
        name: z.string().min(1).max(200),
        title: z.string().max(200).optional(),
        email: z.string().email().optional(),
        phone: z.string().max(40).optional(),
        // Procur PR #316 — surfaced from doc-extraction; stored on
        // the contact's `external_keys.linkedin` so the contact
        // detail page + retrieval pack can display it.
        linkedinUrl: z.string().url().optional(),
      }),
    )
    .max(50)
    .optional(),
  estimatedValueUsd: z.number().nonnegative().optional(),
  /** ISO-8601 date string (YYYY-MM-DD) — kept as text to stay timezone-agnostic. */
  deadline: z.string().max(40).optional(),
  quantity: z
    .object({
      amount: z.number().positive(),
      unit: z.string().min(1).max(20),
    })
    .optional(),
  /** Free-form blob procur stamps the full tender doc into. Stored on the event. */
  rawIntel: z.record(z.unknown()).optional(),
  /**
   * Procur PR #316 — structured sidecar context. Persisted on the
   * lead's `procur_metadata` column and rendered on the org detail
   * page's "Procur intelligence" panel.
   */
  metadata: ProcurMetadataSchema.optional(),
});

export type ProcurLeadIngestPayload = z.infer<typeof ProcurLeadIngestSchema>;

export interface IngestedContact {
  contactId: string;
  /** "created" = brand new row; "duplicate" = matched an existing contact by email/phone/name+org. */
  outcome: "created" | "duplicate";
  matchedOn?: "email" | "phone" | "name_and_org";
}

export interface ProcurLeadIngestResult {
  leadId: string;
  orgId: string;
  /** First entry (if any) is the lead's primary contact. */
  contacts: IngestedContact[];
  vexUrl: string | null;
  /** True when this opportunity was already ingested previously. */
  wasExisting: boolean;
}
