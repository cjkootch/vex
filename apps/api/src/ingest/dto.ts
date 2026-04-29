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
  }),
  contact: z
    .object({
      name: z.string().min(1).max(200),
      title: z.string().max(200).optional(),
      email: z.string().email().optional(),
    })
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
});

export type ProcurLeadIngestPayload = z.infer<typeof ProcurLeadIngestSchema>;

export interface ProcurLeadIngestResult {
  leadId: string;
  orgId: string;
  contactId: string | null;
  vexUrl: string | null;
  /** True when this opportunity was already ingested previously. */
  wasExisting: boolean;
}
