import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Delete,
  Get,
  HttpCode,
  Inject,
  Logger,
  NotFoundException,
  Param,
  Patch,
  Post,
  Query,
  Res,
  UseGuards,
} from "@nestjs/common";
import type { FastifyReply } from "fastify";
import { and, count, desc, eq, inArray, isNull, or } from "drizzle-orm";
import { z } from "zod";
import { createId } from "@vex/domain";
import type { Queue } from "bullmq";
import { addAgentJob, type AgentJobData } from "@vex/agents";
import type {
  EventRepository,
  LeadProcurMetadata,
  OfacScreenRepository,
  OrganizationProductRepository,
  OrganizationRelationshipRepository,
  OrganizationRepository,
} from "@vex/db";
import { JwtAuthGuard, TenantContext } from "../auth/index.js";
import { schema, withTenant, type Db, type Tx } from "@vex/db";

/**
 * GET /organizations        — list of companies in the current tenant,
 *                             optionally filtered by status, enriched
 *                             with a contact count per row.
 * GET /organizations/:id    — single-row detail, including the
 *                             org's contacts (max 200).
 *
 * Both endpoints run inside `withTenant` so RLS isolates reads.
 * Sprint 4's stub echo has been replaced; auth + tenant plumbing is
 * covered by the dedicated `test/auth/auth.test.ts` suite now.
 */

export const ORGANIZATIONS_DB_CLIENT = Symbol("ORGANIZATIONS_DB_CLIENT");
export const ORGANIZATIONS_REPO = Symbol("ORGANIZATIONS_REPO");
export const ORGANIZATIONS_EVENT_REPO = Symbol("ORGANIZATIONS_EVENT_REPO");
export const ORGANIZATIONS_PRODUCTS_REPO = Symbol("ORGANIZATIONS_PRODUCTS_REPO");
export const ORGANIZATIONS_RELATIONSHIPS_REPO = Symbol(
  "ORGANIZATIONS_RELATIONSHIPS_REPO",
);
export const ORGANIZATIONS_AGENTS_QUEUE = Symbol("ORGANIZATIONS_AGENTS_QUEUE");
export const ORGANIZATIONS_OFAC_SCREENS_REPO = Symbol(
  "ORGANIZATIONS_OFAC_SCREENS_REPO",
);

const CreateOrganizationBody = z.object({
  legalName: z.string().min(1).max(200),
  domain: z.string().max(255).optional(),
  industry: z.string().max(120).optional(),
});

/**
 * Editable fields on an organization — only the bits a human enters
 * by hand. Merge metadata (externalKeys, fieldConfidence, fitScore)
 * and status all have their own mutation paths.
 */
const UpdateOrganizationBody = z
  .object({
    legalName: z.string().min(1).max(200),
    domain: z.string().max(255).nullable(),
    industry: z.string().max(120).nullable(),
  })
  .partial();

type RecordStatus = "active" | "archived" | "inactive";

export interface OrganizationListRow {
  id: string;
  legalName: string;
  domain: string | null;
  industry: string | null;
  fitScore: number | null;
  status: string;
  contactCount: number;
  /** Free-form tags applied via org.tag (refinery, state-owned, …). */
  tags: string[];
  /** Counterparty role: buyer / supplier / broker / etc. Null until classified. */
  kind: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface OrganizationContactSummary {
  id: string;
  fullName: string;
  title: string | null;
  email: string | null;
  phone: string | null;
  optedOut: boolean;
}

export interface OrganizationDealSummary {
  id: string;
  dealRef: string;
  status: string;
  product: string;
  volumeUsg: number;
  role: "buyer" | "seller";
}

export interface OrganizationNote {
  body: string;
  createdAt: string;
}

export interface OrganizationDetail extends OrganizationListRow {
  sourceOfTruth: string | null;
  externalKeys: Record<string, string>;
  /** ISO 3166-1 alpha-2 from geo.country, populated by org.update_fields. */
  country: string | null;
  /** Latest OFAC SDN screen status. "unscreened" when never screened. */
  ofacStatus: string;
  /** ISO timestamp of the last OFAC screen, null if never screened. */
  ofacScreenedAt: string | null;
  /** Most-recent crm.note bodies, newest first. Up to 5. */
  notes: OrganizationNote[];
  contacts: OrganizationContactSummary[];
  deals: OrganizationDealSummary[];
  /**
   * Procur sidecar context from the most-recent procur lead pushed
   * for this org (procur PR #316). Drives the "Procur intelligence"
   * panel on the company detail page — KYC badge, datasheet specs,
   * source documents, market context, trading defaults. Null when
   * the org isn't a procur lead.
   */
  procurMetadata: LeadProcurMetadata | null;
  /** ISO timestamp of the procur push that supplied procurMetadata. */
  procurMetadataAt: string | null;
}

const STATUS_VALUES = new Set<RecordStatus>([
  "active",
  "archived",
  "inactive",
]);

/**
 * Bulk soft-delete validator. Capped at 500 ids per request so a
 * runaway client can't archive a whole workspace in one click.
 * Mirrors the contacts equivalent.
 */
const BulkArchiveBody = z.object({
  organizationIds: z.array(z.string().min(1).max(50)).min(1).max(500),
  reason: z.string().max(500).optional(),
});

@Controller("organizations")
@UseGuards(JwtAuthGuard)
export class OrganizationsController {
  private readonly log = new Logger(OrganizationsController.name);

  constructor(
    @Inject(TenantContext) private readonly tenant: TenantContext,
    @Inject(ORGANIZATIONS_DB_CLIENT) private readonly db: Db,
    @Inject(ORGANIZATIONS_REPO) private readonly organizations: OrganizationRepository,
    @Inject(ORGANIZATIONS_EVENT_REPO) private readonly events: EventRepository,
    @Inject(ORGANIZATIONS_PRODUCTS_REPO)
    private readonly orgProducts: OrganizationProductRepository,
    @Inject(ORGANIZATIONS_RELATIONSHIPS_REPO)
    private readonly orgRelationships: OrganizationRelationshipRepository,
    @Inject(ORGANIZATIONS_AGENTS_QUEUE)
    private readonly agentsQueue: Queue<AgentJobData>,
    @Inject(ORGANIZATIONS_OFAC_SCREENS_REPO)
    private readonly ofacScreens: OfacScreenRepository,
  ) {}

  @Get()
  async list(
    @Query("status") statusRaw?: string,
    @Query("limit") limitRaw?: string,
  ): Promise<{ organizations: OrganizationListRow[] }> {
    const status =
      statusRaw && STATUS_VALUES.has(statusRaw as RecordStatus)
        ? (statusRaw as RecordStatus)
        : null;
    const limit = clampLimit(limitRaw, 100, 500);

    const organizations = await withTenant(
      this.db,
      this.tenant.tenantId,
      async (tx) => {
        const base = tx.select().from(schema.organizations);
        const filtered = status
          ? base.where(eq(schema.organizations.status, status))
          : base;
        const rows = await filtered
          .orderBy(desc(schema.organizations.updatedAt))
          .limit(limit);

        if (rows.length === 0) return [];
        const counts = await loadContactCounts(tx);

        return rows.map((row) => ({
          id: row.id,
          legalName: row.legalName,
          domain: row.domain,
          industry: row.industry,
          fitScore: row.fitScore,
          status: row.status,
          contactCount: counts.get(row.id) ?? 0,
          tags: row.tags ?? [],
          kind: row.kind,
          createdAt: row.createdAt.toISOString(),
          updatedAt: row.updatedAt.toISOString(),
        }));
      },
    );

    return { organizations };
  }

  @Post()
  @HttpCode(201)
  async create(
    @Body() raw: unknown,
  ): Promise<{ organization: OrganizationListRow }> {
    const parsed = CreateOrganizationBody.safeParse(raw);
    if (!parsed.success) {
      throw new BadRequestException(parsed.error.message);
    }
    const input = parsed.data;
    const id = createId();
    const { tenantId, userId } = this.tenant;

    const organization = await withTenant(this.db, tenantId, async (tx) => {
      try {
        // Unified dedupe path — approval executor also calls
        // createWithDedupeCheck so both routes collapse onto one
        // normalized-identity check. "Vector Trade Capital" vs
        // "Vector Trade Capital LLC" and "vexhq.ai" vs "www.vexhq.ai"
        // are caught here before any insert runs.
        const result = await this.organizations.createWithDedupeCheck(
          tx,
          tenantId,
          {
            id,
            legalName: input.legalName,
            ...(input.domain ? { domain: input.domain } : {}),
            ...(input.industry ? { industry: input.industry } : {}),
          },
        );
        if (result.kind === "duplicate") {
          throw new ConflictException({
            message: `organization ${input.legalName} already exists`,
            existingOrganizationId: result.organization.id,
          });
        }
        const row = result.organization;
        await this.events.insertIfNotExists(tx, tenantId, {
          verb: "organization.created",
          subjectType: "organization",
          subjectId: id,
          actorType: "user",
          actorId: userId,
          objectType: "organization",
          objectId: id,
          occurredAt: new Date(),
          idempotencyKey: `organization.created:${id}`,
          metadata: {
            legal_name: input.legalName,
            domain: input.domain ?? null,
            created_by: userId,
          },
        });
        return row;
      } catch (err) {
        const msg = (err as Error).message;
        if (msg.includes("duplicate") || msg.includes("unique")) {
          throw new ConflictException(`organization ${input.legalName} exists`);
        }
        throw err;
      }
    });

    this.log.log(`organization ${input.legalName} (${id}) created by ${userId}`);

    // Fire-and-forget OFAC screen for the new counterparty so the
    // buyer-intel card isn't "unscreened" in the deal creator. We don't
    // await the write — if Redis is momentarily unavailable the daily
    // 07:00 cron will still pick the org up. addAgentJob uses a
    // dedupe key so a rapid re-POST can't pile duplicate jobs.
    void addAgentJob(
      this.agentsQueue,
      {
        kind: "ofac_screening",
        workspace_id: tenantId,
        input: { organization_id: organization.id },
      },
      `ofac_screen:${organization.id}:${dayBucket()}`,
    ).catch((err) => {
      this.log.warn(
        `failed to enqueue OFAC screen for ${organization.id}: ${(err as Error).message}`,
      );
    });

    return {
      organization: {
        id: organization.id,
        legalName: organization.legalName,
        domain: organization.domain,
        industry: organization.industry,
        fitScore: organization.fitScore,
        status: organization.status,
        contactCount: 0,
        tags: organization.tags ?? [],
        kind: organization.kind,
        createdAt: organization.createdAt.toISOString(),
        updatedAt: organization.updatedAt.toISOString(),
      },
    };
  }

  /**
   * CSV-import path. Accepts up to 500 rows; each flows through the
   * same `createWithDedupeCheck` the single-create endpoint uses, so
   * "Acme" + "Acme Corp" + "acme.com" collapse together. Returns
   * counts plus per-row outcomes so the UI can surface which rows
   * matched an existing org vs were newly created.
   */
  /**
   * Bulk soft-delete companies (status flip to `archived`). Called
   * from /app/companies when an operator selects N rows + confirms in
   * the typed-confirmation modal. Single audit event covers the
   * batch so the events feed has one row per archive action, not N.
   * Mirrors POST /contacts/bulk-archive.
   */
  @Post("bulk-archive")
  async bulkArchive(@Body() raw: unknown) {
    const parsed = BulkArchiveBody.safeParse(raw);
    if (!parsed.success) {
      throw new BadRequestException(parsed.error.message);
    }
    const { organizationIds, reason } = parsed.data;
    const tenantId = this.tenant.tenantId;
    const actorUserId = this.tenant.userId;
    return withTenant(this.db, tenantId, async (tx) => {
      const updated = await this.organizations.updateStatusByIds(
        tx,
        organizationIds,
        "archived",
      );
      const archivedIds = updated.map((o) => o.id);
      if (archivedIds.length > 0) {
        await this.events.insertIfNotExists(tx, tenantId, {
          verb: "organizations.bulk_archived",
          subjectType: "organization",
          // First id as the subject so the org-detail timeline
          // surfaces the archive event for at least one of the batch.
          subjectId: archivedIds[0]!,
          actorType: "user",
          actorId: actorUserId,
          objectType: "organization",
          objectId: archivedIds[0]!,
          occurredAt: new Date(),
          idempotencyKey: `organizations.bulk_archived:${actorUserId}:${Date.now()}:${archivedIds.length}`,
          metadata: {
            archived_count: archivedIds.length,
            requested_count: organizationIds.length,
            archived_ids: archivedIds,
            reason: reason ?? null,
          },
        });
      }
      this.log.log(
        `bulk-archived ${archivedIds.length}/${organizationIds.length} organizations by ${actorUserId}`,
      );
      return { archivedCount: archivedIds.length, archivedIds };
    });
  }

  @Post("bulk")
  @HttpCode(200)
  async bulkCreate(
    @Body() raw: unknown,
  ): Promise<{
    imported: number;
    duplicates: number;
    failed: number;
    rows: Array<{
      index: number;
      status: "created" | "duplicate" | "failed";
      id?: string;
      error?: string;
    }>;
  }> {
    const parsed = z
      .object({
        rows: z.array(CreateOrganizationBody).min(1).max(500),
      })
      .safeParse(raw);
    if (!parsed.success) {
      throw new BadRequestException(parsed.error.message);
    }
    const { tenantId, userId } = this.tenant;

    const results: Array<{
      index: number;
      status: "created" | "duplicate" | "failed";
      id?: string;
      error?: string;
    }> = [];

    for (let i = 0; i < parsed.data.rows.length; i += 1) {
      const input = parsed.data.rows[i]!;
      try {
        const id = createId();
        const outcome = await withTenant(this.db, tenantId, async (tx) => {
          const result = await this.organizations.createWithDedupeCheck(tx, tenantId, {
            id,
            legalName: input.legalName,
            ...(input.domain ? { domain: input.domain } : {}),
            ...(input.industry ? { industry: input.industry } : {}),
          });
          if (result.kind === "duplicate") {
            return {
              status: "duplicate" as const,
              id: result.organization.id,
            };
          }
          await this.events.insertIfNotExists(tx, tenantId, {
            verb: "organization.created",
            subjectType: "organization",
            subjectId: id,
            actorType: "user",
            actorId: userId,
            objectType: "organization",
            objectId: id,
            occurredAt: new Date(),
            idempotencyKey: `organization.created:${id}`,
            metadata: {
              legal_name: input.legalName,
              domain: input.domain ?? null,
              created_by: userId,
              import_batch: true,
            },
          });
          return { status: "created" as const, id };
        });
        results.push({ index: i, ...outcome });
      } catch (err) {
        results.push({
          index: i,
          status: "failed",
          error: (err as Error).message,
        });
      }
    }

    const imported = results.filter((r) => r.status === "created").length;
    const duplicates = results.filter((r) => r.status === "duplicate").length;
    const failed = results.filter((r) => r.status === "failed").length;
    this.log.log(
      `bulk org import: imported=${imported} duplicates=${duplicates} failed=${failed} by=${userId}`,
    );
    return { imported, duplicates, failed, rows: results };
  }

  @Patch(":id")
  async update(
    @Param("id") id: string,
    @Body() raw: unknown,
  ): Promise<{ organization: OrganizationDetail }> {
    const parsed = UpdateOrganizationBody.safeParse(raw);
    if (!parsed.success) {
      throw new BadRequestException(parsed.error.message);
    }
    const patch = parsed.data;
    const { tenantId, userId } = this.tenant;

    const organization = await withTenant(this.db, tenantId, async (tx) => {
      const before = await this.organizations.findById(tx, id);
      if (!before) throw new NotFoundException(`organization ${id} not found`);

      const set: Record<string, unknown> = { updatedAt: new Date() };
      if (patch.legalName !== undefined) set["legalName"] = patch.legalName;
      if (patch.domain !== undefined) set["domain"] = patch.domain;
      if (patch.industry !== undefined) set["industry"] = patch.industry;

      let after;
      try {
        [after] = await tx
          .update(schema.organizations)
          .set(set)
          .where(eq(schema.organizations.id, id))
          .returning();
      } catch (err) {
        const msg = (err as Error).message;
        if (msg.includes("duplicate") || msg.includes("unique")) {
          throw new ConflictException(
            `organization ${patch.legalName ?? before.legalName} exists`,
          );
        }
        throw err;
      }
      if (!after) throw new Error(`organization ${id} vanished during update`);

      await this.events.insertIfNotExists(tx, tenantId, {
        verb: "organization.updated",
        subjectType: "organization",
        subjectId: id,
        actorType: "user",
        actorId: userId,
        objectType: "organization",
        objectId: id,
        occurredAt: new Date(),
        // Stable key tied to before.updatedAt so a retry dedupes but a
        // follow-up edit records a distinct row.
        idempotencyKey: `organization.updated:${id}:${before.updatedAt.toISOString()}`,
        metadata: {
          patch,
          before,
          after,
          audit_event_id: createId(),
        },
      });

      // Rehydrate contacts + deals so the response mirrors the detail
      // endpoint shape the UI already renders. Same filter set as the
      // detail handler — drop archived contacts, merge tombstones,
      // and ended memberships.
      const contactRows = await tx
        .select({
          contact: schema.contacts,
          role: schema.contactOrgMemberships.role,
          isPrimary: schema.contactOrgMemberships.isPrimary,
        })
        .from(schema.contactOrgMemberships)
        .innerJoin(
          schema.contacts,
          eq(schema.contactOrgMemberships.contactId, schema.contacts.id),
        )
        .where(
          and(
            eq(schema.contactOrgMemberships.orgId, id),
            isNull(schema.contactOrgMemberships.until),
            eq(schema.contacts.status, "active"),
            isNull(schema.contacts.mergedIntoContactId),
          ),
        )
        .orderBy(desc(schema.contacts.updatedAt))
        .limit(200);
      const contacts = contactRows.map((r) => r.contact);

      const dealRows = await tx
        .select({
          id: schema.fuelDeals.id,
          dealRef: schema.fuelDeals.dealRef,
          status: schema.fuelDeals.status,
          product: schema.fuelDeals.product,
          volumeUsg: schema.fuelDeals.volumeUsg,
          buyerOrgId: schema.fuelDeals.buyerOrgId,
          sellerOrgId: schema.fuelDeals.sellerOrgId,
        })
        .from(schema.fuelDeals)
        .where(
          or(
            eq(schema.fuelDeals.buyerOrgId, id),
            eq(schema.fuelDeals.sellerOrgId, id),
          ),
        )
        .orderBy(desc(schema.fuelDeals.createdAt))
        .limit(100);
      const deals: OrganizationDealSummary[] = dealRows.map((d) => ({
        id: d.id,
        dealRef: d.dealRef,
        status: d.status,
        product: d.product,
        volumeUsg: d.volumeUsg,
        role: d.buyerOrgId === id ? "buyer" : "seller",
      }));

      const country = (after.geo as { country?: unknown } | null)?.country;
      const detail: OrganizationDetail = {
        id: after.id,
        legalName: after.legalName,
        domain: after.domain,
        industry: after.industry,
        fitScore: after.fitScore,
        status: after.status,
        sourceOfTruth: after.sourceOfTruth,
        externalKeys: after.externalKeys,
        contactCount: contacts.length,
        tags: after.tags ?? [],
        kind: after.kind,
        country: typeof country === "string" ? country : null,
        ofacStatus: after.ofacStatus,
        ofacScreenedAt: after.ofacScreenedAt?.toISOString() ?? null,
        // After-PATCH detail; freshly-created or freshly-updated orgs
        // typically don't have notes yet — leave empty rather than
        // round-trip the events query for a likely-empty result. Same
        // story for procurMetadata (procur push is a separate flow).
        notes: [],
        procurMetadata: null,
        procurMetadataAt: null,
        createdAt: after.createdAt.toISOString(),
        updatedAt: after.updatedAt.toISOString(),
        contacts: contacts.map((c) => ({
          id: c.id,
          fullName: c.fullName,
          title: c.title,
          email: c.emails[0] ?? null,
          phone: c.phones[0] ?? null,
          optedOut: c.optOutAt !== null,
        })),
        deals,
      };
      return detail;
    });

    this.log.log(`organization ${id} updated by ${userId}`);
    return { organization };
  }

  @Get(":id")
  async detail(@Param("id") id: string): Promise<{ organization: OrganizationDetail }> {
    const organization = await withTenant(
      this.db,
      this.tenant.tenantId,
      async (tx) => {
        const [row] = await tx
          .select()
          .from(schema.organizations)
          .where(eq(schema.organizations.id, id))
          .limit(1);
        if (!row) return null;

        // Read through the m:n memberships table so a contact that
        // represents multiple orgs shows up on every one of its orgs'
        // detail pages — not only the single org stored in
        // `contacts.org_id`.
        //
        // Three filters keep tombstoned / removed rows out of the
        // tab list. Without them, archived contacts (operator hit
        // bulk-archive) and merged-into ones (contact.merge writes a
        // tombstone pointer) keep showing up on the company page —
        // exactly the bug an operator caught on a workspace with
        // ~half the contacts being old test data.
        //   - contacts.status = 'active' — drop archived rows.
        //   - contacts.merged_into_contact_id IS NULL — drop tombstones
        //     left behind by contact.merge so we don't render the
        //     old archived row.
        //   - contact_org_memberships.until IS NULL — drop memberships
        //     the operator explicitly ended (set when a contact moves
        //     between orgs without us deleting the row outright).
        const contactRows = await tx
          .select({
            contact: schema.contacts,
            role: schema.contactOrgMemberships.role,
            isPrimary: schema.contactOrgMemberships.isPrimary,
          })
          .from(schema.contactOrgMemberships)
          .innerJoin(
            schema.contacts,
            eq(schema.contactOrgMemberships.contactId, schema.contacts.id),
          )
          .where(
            and(
              eq(schema.contactOrgMemberships.orgId, id),
              isNull(schema.contactOrgMemberships.until),
              eq(schema.contacts.status, "active"),
              isNull(schema.contacts.mergedIntoContactId),
            ),
          )
          .orderBy(desc(schema.contacts.updatedAt))
          .limit(200);
        const contacts = contactRows.map((r) => r.contact);

        // Deals where this org is buyer or seller — powers the Deals
        // tab on the detail page.
        const dealRows = await tx
          .select({
            id: schema.fuelDeals.id,
            dealRef: schema.fuelDeals.dealRef,
            status: schema.fuelDeals.status,
            product: schema.fuelDeals.product,
            volumeUsg: schema.fuelDeals.volumeUsg,
            buyerOrgId: schema.fuelDeals.buyerOrgId,
            sellerOrgId: schema.fuelDeals.sellerOrgId,
          })
          .from(schema.fuelDeals)
          .where(
            or(
              eq(schema.fuelDeals.buyerOrgId, id),
              eq(schema.fuelDeals.sellerOrgId, id),
            ),
          )
          .orderBy(desc(schema.fuelDeals.createdAt))
          .limit(100);
        const deals: OrganizationDealSummary[] = dealRows.map((d) => ({
          id: d.id,
          dealRef: d.dealRef,
          status: d.status,
          product: d.product,
          volumeUsg: d.volumeUsg,
          role: d.buyerOrgId === id ? "buyer" : "seller",
        }));

        // Recent research notes (crm.note → organization.note_added).
        // Surfaced inline on the org page so operators have research
        // context for outreach without hunting the activity timeline.
        const noteRows = await tx
          .select({
            metadata: schema.events.metadata,
            occurredAt: schema.events.occurredAt,
          })
          .from(schema.events)
          .where(
            and(
              eq(schema.events.subjectType, "organization"),
              eq(schema.events.subjectId, id),
              eq(schema.events.verb, "organization.note_added"),
            ),
          )
          .orderBy(desc(schema.events.occurredAt))
          .limit(5);
        const notes: OrganizationNote[] = noteRows
          .map((n) => {
            const body = (n.metadata as { body?: unknown } | null)?.body;
            return typeof body === "string" && body.trim().length > 0
              ? { body: body.trim(), createdAt: n.occurredAt.toISOString() }
              : null;
          })
          .filter((x): x is OrganizationNote => x !== null);

        // Most-recent procur lead's sidecar metadata (PR #316). Drives
        // the "Procur intelligence" panel. We pick the freshest by
        // updatedAt so re-pushes (procur user re-clicks "Send to Vex"
        // after editing the proforma) overwrite stale context.
        const [procurLead] = await tx
          .select({
            procurMetadata: schema.leads.procurMetadata,
            updatedAt: schema.leads.updatedAt,
          })
          .from(schema.leads)
          .where(
            and(
              eq(schema.leads.orgId, id),
              eq(schema.leads.stage, "procur_inbound"),
            ),
          )
          .orderBy(desc(schema.leads.updatedAt))
          .limit(1);
        const procurMetadata = procurLead?.procurMetadata ?? null;
        const procurMetadataAt = procurLead?.updatedAt
          ? procurLead.updatedAt.toISOString()
          : null;

        const country =
          (row.geo as { country?: unknown } | null)?.country;

        const detail: OrganizationDetail = {
          id: row.id,
          legalName: row.legalName,
          domain: row.domain,
          industry: row.industry,
          fitScore: row.fitScore,
          status: row.status,
          sourceOfTruth: row.sourceOfTruth,
          externalKeys: row.externalKeys,
          contactCount: contacts.length,
          tags: row.tags ?? [],
          kind: row.kind,
          country: typeof country === "string" ? country : null,
          ofacStatus: row.ofacStatus,
          ofacScreenedAt: row.ofacScreenedAt?.toISOString() ?? null,
          notes,
          createdAt: row.createdAt.toISOString(),
          updatedAt: row.updatedAt.toISOString(),
          contacts: contacts.map((c) => ({
            id: c.id,
            fullName: c.fullName,
            title: c.title,
            email: c.emails[0] ?? null,
            phone: c.phones[0] ?? null,
            optedOut: c.optOutAt !== null,
          })),
          deals,
          procurMetadata,
          procurMetadataAt,
        };
        return detail;
      },
    );
    if (!organization)
      throw new NotFoundException(`organization ${id} not found`);
    return { organization };
  }

  // -------------------------------------------------------------------
  // Sprint W — products + broker/supplier relationships
  // -------------------------------------------------------------------

  /**
   * Operational pulse for a counterparty. Aggregates the signals an
   * operator needs at a glance on the org's hero band:
   *
   *   · Role counts across open deals (buyer / supplier / broker /
   *     intermediary). Powers the role-badge strip.
   *   · Recent open deals (top 10 by updatedAt) with role annotated.
   *   · Lifetime closed-deal count + summed volume (any role).
   *   · OFAC status + last screen; counterparty risk tier.
   *   · Contact count (active memberships) and last touchpoint.
   *
   * One HTTP round-trip, a handful of queries — fine at VTC scale.
   */
  @Get(":id/pulse")
  async pulse(@Param("id") id: string) {
    return withTenant(this.db, this.tenant.tenantId, async (tx) => {
      const [org] = await tx
        .select()
        .from(schema.organizations)
        .where(eq(schema.organizations.id, id))
        .limit(1);
      if (!org) throw new NotFoundException(`organization ${id} not found`);

      const OPEN_STATUSES: Array<
        "draft"
        | "negotiating"
        | "pending_approval"
        | "approved"
        | "loading"
        | "in_transit"
        | "delivered"
      > = [
        "draft",
        "negotiating",
        "pending_approval",
        "approved",
        "loading",
        "in_transit",
        "delivered",
      ];

      const [
        buyerOpen,
        supplierOpen,
        participantRows,
        closedVolumeRows,
        closedCountRows,
        latestScore,
        contactCountRows,
        lastTouchpoint,
      ] = await Promise.all([
        tx
          .select({
            id: schema.fuelDeals.id,
            dealRef: schema.fuelDeals.dealRef,
            status: schema.fuelDeals.status,
            product: schema.fuelDeals.product,
            volumeUsg: schema.fuelDeals.volumeUsg,
            volumeUnit: schema.fuelDeals.volumeUnit,
            updatedAt: schema.fuelDeals.updatedAt,
          })
          .from(schema.fuelDeals)
          .where(
            and(
              eq(schema.fuelDeals.buyerOrgId, id),
              inArray(schema.fuelDeals.status, OPEN_STATUSES),
            ),
          ),
        tx
          .select({
            id: schema.fuelDeals.id,
            dealRef: schema.fuelDeals.dealRef,
            status: schema.fuelDeals.status,
            product: schema.fuelDeals.product,
            volumeUsg: schema.fuelDeals.volumeUsg,
            volumeUnit: schema.fuelDeals.volumeUnit,
            updatedAt: schema.fuelDeals.updatedAt,
          })
          .from(schema.fuelDeals)
          .where(
            and(
              eq(schema.fuelDeals.sellerOrgId, id),
              inArray(schema.fuelDeals.status, OPEN_STATUSES),
            ),
          ),
        tx
          .select({
            dealId: schema.fuelDealParticipants.dealId,
            partyType: schema.fuelDealParticipants.partyType,
          })
          .from(schema.fuelDealParticipants)
          .where(eq(schema.fuelDealParticipants.orgId, id)),
        tx
          .select({
            volumeUsg: schema.fuelDeals.volumeUsg,
          })
          .from(schema.fuelDeals)
          .where(
            and(
              eq(schema.fuelDeals.status, "settled"),
              or(
                eq(schema.fuelDeals.buyerOrgId, id),
                eq(schema.fuelDeals.sellerOrgId, id),
              ),
            ),
          ),
        tx
          .select({ id: schema.fuelDeals.id })
          .from(schema.fuelDeals)
          .where(
            and(
              eq(schema.fuelDeals.status, "settled"),
              or(
                eq(schema.fuelDeals.buyerOrgId, id),
                eq(schema.fuelDeals.sellerOrgId, id),
              ),
            ),
          ),
        tx
          .select()
          .from(schema.fuelDealCounterpartyScores)
          .where(eq(schema.fuelDealCounterpartyScores.orgId, id))
          .orderBy(desc(schema.fuelDealCounterpartyScores.scoredAt))
          .limit(1),
        tx
          .select({ id: schema.contactOrgMemberships.contactId })
          .from(schema.contactOrgMemberships)
          .innerJoin(
            schema.contacts,
            eq(schema.contactOrgMemberships.contactId, schema.contacts.id),
          )
          .where(
            and(
              eq(schema.contactOrgMemberships.orgId, id),
              isNull(schema.contactOrgMemberships.until),
              eq(schema.contacts.status, "active"),
              isNull(schema.contacts.mergedIntoContactId),
            ),
          ),
        tx
          .select({
            channel: schema.touchpoints.channel,
            occurredAt: schema.touchpoints.occurredAt,
          })
          .from(schema.touchpoints)
          .where(eq(schema.touchpoints.orgId, id))
          .orderBy(desc(schema.touchpoints.occurredAt))
          .limit(1),
      ]);

      // Role classification from participant rows. Brokers + intermediaries
      // live on fuel_deal_participants; buyer/supplier are on fuel_deals
      // itself and already covered above.
      const brokerDealIds = new Set<string>();
      const intermediaryDealIds = new Set<string>();
      for (const p of participantRows) {
        if (
          p.partyType === "supplier_broker" ||
          p.partyType === "buyer_broker" ||
          p.partyType === "broker"
        ) {
          brokerDealIds.add(p.dealId);
        } else if (p.partyType === "intermediary") {
          intermediaryDealIds.add(p.dealId);
        }
      }

      // Combine open deals with role annotation. A single deal can land
      // in multiple role buckets (rare but allowed — e.g. buyer + broker).
      type OpenDealOut = {
        dealId: string;
        dealRef: string;
        status: string;
        product: string;
        volumeUsg: number;
        volumeUnit: string;
        updatedAt: string;
        role: string;
      };
      const openDealsMap = new Map<string, OpenDealOut>();
      for (const d of buyerOpen) {
        openDealsMap.set(d.id, {
          dealId: d.id,
          dealRef: d.dealRef,
          status: d.status,
          product: d.product,
          volumeUsg: d.volumeUsg,
          volumeUnit: d.volumeUnit,
          updatedAt: d.updatedAt.toISOString(),
          role: "buyer",
        });
      }
      for (const d of supplierOpen) {
        const existing = openDealsMap.get(d.id);
        if (existing) {
          existing.role = `${existing.role} + supplier`;
        } else {
          openDealsMap.set(d.id, {
            dealId: d.id,
            dealRef: d.dealRef,
            status: d.status,
            product: d.product,
            volumeUsg: d.volumeUsg,
            volumeUnit: d.volumeUnit,
            updatedAt: d.updatedAt.toISOString(),
            role: "supplier",
          });
        }
      }

      const openDeals = Array.from(openDealsMap.values())
        .sort((a, b) =>
          b.updatedAt.localeCompare(a.updatedAt),
        )
        .slice(0, 10);

      const roleCounts = {
        buyer: buyerOpen.length,
        supplier: supplierOpen.length,
        broker: brokerDealIds.size,
        intermediary: intermediaryDealIds.size,
      };

      const lifetimeVolumeUsg = closedVolumeRows.reduce(
        (acc, r) => acc + (r.volumeUsg ?? 0),
        0,
      );

      const firstTouchpoint = lastTouchpoint[0] ?? null;

      return {
        org: {
          id: org.id,
          legalName: org.legalName,
          domain: org.domain,
          industry: org.industry,
          status: org.status,
          ofacStatus: org.ofacStatus,
          ofacScreenedAt: org.ofacScreenedAt
            ? org.ofacScreenedAt.toISOString()
            : null,
        },
        roleCounts,
        openDeals,
        closedDealCount: closedCountRows.length,
        lifetimeVolumeUsg,
        contactCount: contactCountRows.length,
        riskTier: latestScore[0]?.riskTier ?? null,
        riskTierScoredAt: latestScore[0]?.scoredAt
          ? latestScore[0].scoredAt.toISOString()
          : null,
        lastTouchpointAt: firstTouchpoint?.occurredAt
          ? firstTouchpoint.occurredAt.toISOString()
          : null,
        lastTouchpointChannel: firstTouchpoint?.channel ?? null,
      };
    });
  }

  @Get(":id/products")
  async listProducts(@Param("id") id: string): Promise<{
    products: Array<{
      id: string;
      product: string;
      notes: string | null;
      addedAt: string;
    }>;
  }> {
    const rows = await withTenant(this.db, this.tenant.tenantId, async (tx) =>
      this.orgProducts.listForOrg(tx, id),
    );
    return {
      products: rows.map((r) => ({
        id: r.id,
        product: r.product,
        notes: r.notes,
        addedAt: r.addedAt.toISOString(),
      })),
    };
  }

  @Post(":id/products")
  @HttpCode(201)
  async addProduct(
    @Param("id") id: string,
    @Body() raw: unknown,
  ): Promise<{ id: string; product: string }> {
    const parsed = z
      .object({
        product: z.string().min(1).max(120),
        notes: z.string().max(1000).optional(),
      })
      .safeParse(raw);
    if (!parsed.success) {
      throw new BadRequestException(parsed.error.message);
    }
    const row = await withTenant(this.db, this.tenant.tenantId, async (tx) =>
      this.orgProducts.upsert(tx, this.tenant.tenantId, {
        orgId: id,
        product: parsed.data.product,
        notes: parsed.data.notes ?? null,
        addedBy: this.tenant.userId,
      }),
    );
    return { id: row.id, product: row.product };
  }

  @Delete(":id/products/:productId")
  @HttpCode(204)
  async removeProduct(
    @Param("id") _orgId: string,
    @Param("productId") productId: string,
  ): Promise<void> {
    await withTenant(this.db, this.tenant.tenantId, async (tx) =>
      this.orgProducts.deleteById(tx, productId),
    );
  }

  @Get(":id/relationships")
  async listRelationships(@Param("id") id: string): Promise<{
    relationships: Array<{
      id: string;
      fromOrgId: string;
      toOrgId: string;
      relationshipType: string;
      product: string | null;
      notes: string | null;
      addedAt: string;
    }>;
  }> {
    const rows = await withTenant(this.db, this.tenant.tenantId, async (tx) =>
      this.orgRelationships.listForOrg(tx, id),
    );
    return {
      relationships: rows.map((r) => ({
        id: r.id,
        fromOrgId: r.fromOrgId,
        toOrgId: r.toOrgId,
        relationshipType: r.relationshipType,
        product: r.product,
        notes: r.notes,
        addedAt: r.addedAt.toISOString(),
      })),
    };
  }

  @Post(":id/relationships")
  @HttpCode(201)
  async addRelationship(
    @Param("id") id: string,
    @Body() raw: unknown,
  ): Promise<{ id: string; relationshipType: string }> {
    const parsed = z
      .object({
        toOrgId: z.string().min(1),
        relationshipType: z.enum([
          "brokers_for",
          "sources_from",
          "partners_with",
          "subsidiary_of",
        ]),
        product: z.string().max(120).optional(),
        notes: z.string().max(1000).optional(),
      })
      .safeParse(raw);
    if (!parsed.success) {
      throw new BadRequestException(parsed.error.message);
    }
    if (parsed.data.toOrgId === id) {
      throw new BadRequestException(
        "from_org and to_org must be different organizations",
      );
    }
    const row = await withTenant(this.db, this.tenant.tenantId, async (tx) =>
      this.orgRelationships.upsert(tx, this.tenant.tenantId, {
        fromOrgId: id,
        toOrgId: parsed.data.toOrgId,
        relationshipType: parsed.data.relationshipType,
        product: parsed.data.product ?? null,
        notes: parsed.data.notes ?? null,
        addedBy: this.tenant.userId,
      }),
    );
    return { id: row.id, relationshipType: row.relationshipType };
  }

  @Delete(":id/relationships/:relId")
  @HttpCode(204)
  async removeRelationship(
    @Param("id") _orgId: string,
    @Param("relId") relId: string,
  ): Promise<void> {
    await withTenant(this.db, this.tenant.tenantId, async (tx) =>
      this.orgRelationships.deleteById(tx, relId),
    );
  }

  // -------------------------------------------------------------------
  // OFAC screening — per-org manual trigger + audit-trail export
  // -------------------------------------------------------------------

  /**
   * POST /organizations/:id/ofac/screen
   *
   * Operator-triggered OFAC screen for a single counterparty. Same
   * agent, same dataset as the workspace-wide overnight run — just
   * scoped to one org via input.organization_id. Idempotent at the
   * worker level: enqueueing twice in the same minute coalesces.
   *
   * 202 Accepted — the screen runs asynchronously in the worker;
   * poll the org detail endpoint for `ofacStatus` / `ofacScreenedAt`
   * to see the result. Or hit /ofac/export below for the full
   * audit trail.
   */
  @Post(":id/ofac/screen")
  @HttpCode(202)
  async runOfacScreen(
    @Param("id") orgId: string,
  ): Promise<{ jobId: string; status: "queued" }> {
    const jobId = `ofac:${orgId}:${Date.now()}`;
    await addAgentJob(
      this.agentsQueue,
      {
        kind: "ofac_screening",
        workspace_id: this.tenant.workspaceId,
        input: { organization_id: orgId },
      },
      jobId,
    );
    await withTenant(this.db, this.tenant.tenantId, async (tx) => {
      await this.events.insertIfNotExists(tx, this.tenant.tenantId, {
        verb: "ofac.screen_requested",
        subjectType: "organization",
        subjectId: orgId,
        actorType: "user",
        actorId: this.tenant.userId,
        occurredAt: new Date(),
        idempotencyKey: `ofac.screen_requested:${jobId}`,
        metadata: { triggered_from: "org_detail_page", scope: "single_org" },
      });
    });
    return { jobId, status: "queued" };
  }

  /**
   * GET /organizations/:id/ofac/export
   *
   * Audit-trail export of the latest OFAC screen for this org.
   * Returns JSON the operator can save to disk for compliance review:
   * org name, status, screening timestamp, the matches found (or
   * empty list if none), the highest similarity score, and the agent
   * run id that produced it.
   *
   * Sets Content-Disposition: attachment so a browser fetch downloads
   * as a file rather than rendering inline.
   *
   * 404 if the org has never been screened.
   */
  @Get(":id/ofac/export")
  async exportOfacScreen(
    @Param("id") orgId: string,
    @Res() res: FastifyReply,
  ): Promise<void> {
    const result = await withTenant(
      this.db,
      this.tenant.tenantId,
      async (tx) => {
        const org = await this.organizations.findById(tx, orgId);
        if (!org) return null;
        const screen = await this.ofacScreens.latestForOrg(tx, orgId);
        return { org, screen };
      },
    );
    if (!result) throw new NotFoundException(`organization ${orgId} not found`);
    if (!result.screen) {
      throw new NotFoundException(
        `organization ${orgId} has never been OFAC-screened`,
      );
    }
    const exportedAt = new Date().toISOString();
    const payload = {
      exportedAt,
      exportedBy: this.tenant.userId,
      organization: {
        id: result.org.id,
        legalName: result.org.legalName,
        domain: result.org.domain,
        country:
          (result.org.geo as { country?: unknown } | null)?.country ?? null,
        kind: result.org.kind,
        ofacStatus: result.org.ofacStatus,
        ofacScreenedAt: result.org.ofacScreenedAt?.toISOString() ?? null,
        ofacHighestScore: result.org.ofacHighestScore,
      },
      screen: {
        id: result.screen.id,
        status: result.screen.status,
        screenedAt: result.screen.screenedAt.toISOString(),
        highestScore: result.screen.highestScore,
        matchCount: result.screen.matchCount,
        matches: result.screen.matches,
      },
    };
    const filename = `ofac-screen-${result.org.legalName.replace(/[^a-z0-9]+/gi, "-").toLowerCase()}-${exportedAt.slice(0, 10)}.json`;
    res
      .header("content-type", "application/json; charset=utf-8")
      .header("content-disposition", `attachment; filename="${filename}"`)
      .send(JSON.stringify(payload, null, 2));
  }
}

function clampLimit(raw: string | undefined, fallback: number, max: number): number {
  const parsed = raw ? Number.parseInt(raw, 10) : fallback;
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.min(parsed, max);
}

async function loadContactCounts(tx: Tx): Promise<Map<string, number>> {
  // Count via the m:n memberships table so a contact shared across
  // multiple orgs counts once per org it belongs to. Filter out
  // tombstoned and ended rows so the column on the companies list
  // matches the count operators see when they actually open the
  // org's Contacts tab — same posture as the detail handler's
  // `contacts` query.
  const rows = await tx
    .select({
      orgId: schema.contactOrgMemberships.orgId,
      count: count(),
    })
    .from(schema.contactOrgMemberships)
    .innerJoin(
      schema.contacts,
      eq(schema.contactOrgMemberships.contactId, schema.contacts.id),
    )
    .where(
      and(
        isNull(schema.contactOrgMemberships.until),
        eq(schema.contacts.status, "active"),
        isNull(schema.contacts.mergedIntoContactId),
      ),
    )
    .groupBy(schema.contactOrgMemberships.orgId);
  const out = new Map<string, number>();
  for (const r of rows) out.set(r.orgId, Number(r.count));
  return out;
}


function dayBucket(): string {
  const d = new Date();
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
}
