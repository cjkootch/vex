import { Inject, Injectable, Logger } from "@nestjs/common";
import type { Queue } from "bullmq";
import { addAgentJob, type AgentJobData } from "@vex/agents";
import {
  withTenant,
  type ContactRepository,
  type Db,
  type EventRepository,
  type LeadRepository,
  type OrganizationRepository,
} from "@vex/db";
import { createId } from "@vex/domain";
import type {
  IngestedContact,
  ProcurLeadIngestPayload,
  ProcurLeadIngestResult,
} from "./dto.js";
import {
  INGEST_AGENTS_QUEUE,
  INGEST_CONTACTS_REPO,
  INGEST_DB_CLIENT,
  INGEST_DEFAULT_TENANT_ID,
  INGEST_EVENTS_REPO,
  INGEST_LEADS_REPO,
  INGEST_ORGANIZATIONS_REPO,
  INGEST_WEB_APP_BASE_URL,
} from "./tokens.js";

/**
 * Procur → Vex push handler. Procur's UI fires this when an operator
 * clicks "Send to Vex" on an opportunity:
 *
 *   1. Idempotency check on `externalKeys.procur` — re-clicking the
 *      button returns the existing lead; no duplicate rows.
 *   2. Buyer org upsert: prefer `entitySlug` as the external-key dedupe
 *      handle so future vex→procur enrichment lands on the same row.
 *   3. Contact upsert (only if procur sent one) — email is the strongest
 *      dedupe signal; falls back to phone / name+org.
 *   4. Lead row created with `stage="procur_inbound"` and a one-line
 *      summary in `qualificationSummary` so the operator inbox shows
 *      something useful at a glance.
 *   5. `lead.created.from_procur` event preserves the full payload —
 *      that's where the deep tender details (rawIntel, quantity, etc.)
 *      live so the lead row stays minimal.
 *   6. Fire-and-forget `procur_enrichment` agent job so vex pulls
 *      supplier intelligence in the background — by the time the
 *      operator opens the lead, the org panel is already populated.
 *
 * The ingest write happens inside a single `withTenant` transaction so
 * partial failures don't leave half-created rows. The agent enqueue is
 * deliberately outside the tx — Redis isn't transactional with Postgres
 * and we'd rather lose an enrichment job than fail the ingest.
 */
@Injectable()
export class IngestService {
  private readonly log = new Logger(IngestService.name);

  constructor(
    @Inject(INGEST_DB_CLIENT) private readonly db: Db,
    @Inject(INGEST_ORGANIZATIONS_REPO)
    private readonly organizations: OrganizationRepository,
    @Inject(INGEST_CONTACTS_REPO)
    private readonly contacts: ContactRepository,
    @Inject(INGEST_LEADS_REPO) private readonly leads: LeadRepository,
    @Inject(INGEST_EVENTS_REPO) private readonly events: EventRepository,
    @Inject(INGEST_AGENTS_QUEUE)
    private readonly agentsQueue: Queue<AgentJobData>,
    @Inject(INGEST_DEFAULT_TENANT_ID)
    private readonly defaultTenantId: string,
    @Inject(INGEST_WEB_APP_BASE_URL)
    private readonly webAppBaseUrl: string | null,
  ) {}

  async ingestProcurLead(
    payload: ProcurLeadIngestPayload,
  ): Promise<ProcurLeadIngestResult> {
    const tenantId = this.defaultTenantId;
    const inner = await withTenant(this.db, tenantId, async (tx) => {
      const existing = await this.leads.findByExternalKey(
        tx,
        "procur",
        payload.procurOpportunityId,
      );
      if (existing) {
        // Re-click: don't re-touch contacts, just surface the lead's
        // primary so the operator can navigate. Other contacts at the
        // org are already discoverable via /app/organizations/:id.
        const contacts: IngestedContact[] = existing.contactId
          ? [{ contactId: existing.contactId, outcome: "duplicate" }]
          : [];
        return {
          leadId: existing.id,
          orgId: existing.orgId,
          contacts,
          wasExisting: true,
        };
      }

      const orgKey = payload.buyer.entitySlug ?? null;
      const org = orgKey
        ? await this.organizations.upsertByExternalKey(
            tx,
            tenantId,
            "procur",
            orgKey,
            {
              legalName: payload.buyer.legalName,
              domain: payload.buyer.domain ?? null,
              sourceOfTruth: "procur",
            },
            { incomingConfidence: 0.85 },
          )
        : (
            await this.organizations.createWithDedupeCheck(tx, tenantId, {
              id: createId(),
              legalName: payload.buyer.legalName,
              domain: payload.buyer.domain ?? null,
            })
          ).organization;

      // Loop over contacts. Each gets dedupe'd against existing rows
      // (email > phone > name+org); duplicates are surfaced as
      // `outcome: "duplicate"` so procur's UI can show "merged with
      // existing contact" instead of falsely claiming a new row.
      const ingestedContacts: IngestedContact[] = [];
      for (const c of payload.contacts ?? []) {
        // Procur PR #316 surfaces `linkedinUrl` from doc-extraction;
        // we stash it on the contact's `external_keys.linkedin` so
        // the contact detail page + retrieval pack can display it.
        // ContactEnrichmentAgent later overwrites only when its own
        // confidence beats what procur shipped.
        const externalKeys = c.linkedinUrl
          ? { linkedin: c.linkedinUrl }
          : undefined;
        const result = await this.contacts.createWithDedupeCheck(
          tx,
          tenantId,
          {
            id: createId(),
            orgId: org.id,
            fullName: c.name,
            title: c.title ?? null,
            emails: c.email ? [c.email] : [],
            phones: c.phone ? [c.phone] : [],
            ...(externalKeys ? { externalKeys } : {}),
          },
        );
        if (result.kind === "created") {
          ingestedContacts.push({
            contactId: result.contact.id,
            outcome: "created",
          });
        } else {
          ingestedContacts.push({
            contactId: result.contact.id,
            outcome: "duplicate",
            matchedOn: result.reason,
          });
        }
      }

      const primaryContactId = ingestedContacts[0]?.contactId ?? null;
      // Project the structured procur fields onto the lead's
      // procur_metadata column. Free-form keys (source, sourceRef,
      // pushedAt, awardCount, distressSignals, …) stay in the
      // event metadata where they were before. Keeping the structured
      // sub-objects on the row lets the UI + chat agent read them
      // without scanning event history.
      const procurMetadata = pickProcurMetadata(payload.metadata);
      const lead = await this.leads.create(tx, tenantId, {
        orgId: org.id,
        contactId: primaryContactId,
        status: "new",
        stage: "procur_inbound",
        qualificationSummary: buildLeadSummary(payload),
        externalKeys: { procur: payload.procurOpportunityId },
        procurMetadata,
      });

      await this.events.insertIfNotExists(tx, tenantId, {
        verb: "lead.created.from_procur",
        subjectType: "lead",
        subjectId: lead.id,
        actorType: "service",
        actorId: "procur",
        occurredAt: new Date(),
        idempotencyKey: `procur:${payload.procurOpportunityId}:lead.created`,
        metadata: {
          ...(payload as unknown as Record<string, unknown>),
          ingested_contacts: ingestedContacts,
        },
      });

      return {
        leadId: lead.id,
        orgId: org.id,
        contacts: ingestedContacts,
        wasExisting: false,
      };
    });

    if (!inner.wasExisting) {
      // Org-level enrichment passes (one each, keyed on opportunity id):
      //   - procur_enrichment: pulls supplier intelligence back from
      //     procur (award history, distress signals, etc.)
      //   - research: org-level web research via Anthropic — generates
      //     a brief and may bump fit_score
      // Plus per-newly-created-contact enrichment (skip duplicates;
      // those already had data pre-procur).
      const orgDedupe = `procur_lead:${payload.procurOpportunityId}`;
      const newContactIds = inner.contacts
        .filter((c) => c.outcome === "created")
        .map((c) => c.contactId);
      const enqueues: Array<{ kind: string; promise: Promise<void> }> = [
        {
          kind: "procur_enrichment",
          promise: addAgentJob(
            this.agentsQueue,
            {
              kind: "procur_enrichment",
              workspace_id: tenantId,
              input: { organization_id: inner.orgId },
            },
            orgDedupe,
          ),
        },
        {
          kind: "research",
          promise: addAgentJob(
            this.agentsQueue,
            {
              kind: "research",
              workspace_id: tenantId,
              input: { organization_id: inner.orgId },
            },
            orgDedupe,
          ),
        },
        ...newContactIds.map((contactId) => ({
          kind: "contact_enrichment",
          promise: addAgentJob(
            this.agentsQueue,
            {
              kind: "contact_enrichment" as const,
              workspace_id: tenantId,
              input: { contact_id: contactId },
            },
            // Per-contact dedupe — re-clicking with the same set of
            // already-created contacts won't burn LLM credit twice.
            `procur_contact:${contactId}`,
          ),
        })),
      ];
      const results = await Promise.allSettled(
        enqueues.map((e) => e.promise),
      );
      for (const [i, r] of results.entries()) {
        if (r.status === "rejected") {
          this.log.warn(
            `${enqueues[i]?.kind} enqueue failed for org=${inner.orgId}: ${(r.reason as Error).message}`,
          );
        }
      }
    }

    return {
      ...inner,
      vexUrl: this.webAppBaseUrl
        ? `${this.webAppBaseUrl.replace(/\/$/, "")}/app/companies/${inner.orgId}`
        : null,
    };
  }
}

/**
 * Pull only the structured sub-objects out of the procur metadata
 * blob. The rest (source, sourceRef, distressSignals, …) is free-
 * form and stays on the event metadata where downstream consumers
 * already look for it.
 */
function pickProcurMetadata(
  metadata: ProcurLeadIngestPayload["metadata"],
): import("@vex/db").LeadProcurMetadata {
  if (!metadata) return {};
  const picked: import("@vex/db").LeadProcurMetadata = {};
  if (metadata.procurApproval) picked.procurApproval = metadata.procurApproval;
  if (metadata.productSpecs) picked.productSpecs = metadata.productSpecs;
  if (metadata.sourceDocuments) picked.sourceDocuments = metadata.sourceDocuments;
  if (metadata.marketContext) picked.marketContext = metadata.marketContext;
  if (metadata.procurTradingDefaults) {
    picked.procurTradingDefaults = metadata.procurTradingDefaults;
  }
  return picked;
}

function buildLeadSummary(payload: ProcurLeadIngestPayload): string {
  const parts: string[] = [];
  parts.push(payload.title ?? `Procur lead: ${payload.buyer.legalName}`);
  if (payload.estimatedValueUsd !== undefined) {
    parts.push(`est. $${formatUsdCompact(payload.estimatedValueUsd)}`);
  }
  if (payload.quantity) {
    parts.push(`${payload.quantity.amount}${payload.quantity.unit}`);
  }
  if (payload.deadline) parts.push(`due ${payload.deadline}`);
  return parts.join(" · ");
}

function formatUsdCompact(usd: number): string {
  if (usd >= 1_000_000) return `${(usd / 1_000_000).toFixed(1)}M`;
  if (usd >= 1_000) return `${(usd / 1_000).toFixed(0)}K`;
  return usd.toFixed(0);
}
