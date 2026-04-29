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
        return {
          leadId: existing.id,
          orgId: existing.orgId,
          contactId: existing.contactId,
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

      let contactId: string | null = null;
      if (payload.contact) {
        const created = await this.contacts.createWithDedupeCheck(
          tx,
          tenantId,
          {
            id: createId(),
            orgId: org.id,
            fullName: payload.contact.name,
            title: payload.contact.title ?? null,
            emails: payload.contact.email ? [payload.contact.email] : [],
          },
        );
        contactId = created.contact.id;
      }

      const lead = await this.leads.create(tx, tenantId, {
        orgId: org.id,
        contactId,
        status: "new",
        stage: "procur_inbound",
        qualificationSummary: buildLeadSummary(payload),
        externalKeys: { procur: payload.procurOpportunityId },
      });

      await this.events.insertIfNotExists(tx, tenantId, {
        verb: "lead.created.from_procur",
        subjectType: "lead",
        subjectId: lead.id,
        actorType: "service",
        actorId: "procur",
        occurredAt: new Date(),
        idempotencyKey: `procur:${payload.procurOpportunityId}:lead.created`,
        metadata: payload as unknown as Record<string, unknown>,
      });

      return {
        leadId: lead.id,
        orgId: org.id,
        contactId,
        wasExisting: false,
      };
    });

    if (!inner.wasExisting) {
      try {
        await addAgentJob(
          this.agentsQueue,
          {
            kind: "procur_enrichment",
            workspace_id: tenantId,
            input: { organization_id: inner.orgId },
          },
          `procur_lead:${payload.procurOpportunityId}`,
        );
      } catch (err) {
        this.log.warn(
          `procur_enrichment enqueue failed for org=${inner.orgId}: ${(err as Error).message}`,
        );
      }
    }

    return {
      ...inner,
      vexUrl: this.webAppBaseUrl
        ? `${this.webAppBaseUrl.replace(/\/$/, "")}/app/leads/${inner.leadId}`
        : null,
    };
  }
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
