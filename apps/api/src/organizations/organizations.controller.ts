import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Get,
  HttpCode,
  Inject,
  Logger,
  NotFoundException,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from "@nestjs/common";
import { count, desc, eq, or } from "drizzle-orm";
import { z } from "zod";
import { createId } from "@vex/domain";
import type { EventRepository, OrganizationRepository } from "@vex/db";
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

export interface OrganizationDetail extends OrganizationListRow {
  sourceOfTruth: string | null;
  externalKeys: Record<string, string>;
  contacts: OrganizationContactSummary[];
  deals: OrganizationDealSummary[];
}

const STATUS_VALUES = new Set<RecordStatus>([
  "active",
  "archived",
  "inactive",
]);

@Controller("organizations")
@UseGuards(JwtAuthGuard)
export class OrganizationsController {
  private readonly log = new Logger(OrganizationsController.name);

  constructor(
    @Inject(TenantContext) private readonly tenant: TenantContext,
    @Inject(ORGANIZATIONS_DB_CLIENT) private readonly db: Db,
    @Inject(ORGANIZATIONS_REPO) private readonly organizations: OrganizationRepository,
    @Inject(ORGANIZATIONS_EVENT_REPO) private readonly events: EventRepository,
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
      // Dedupe guard: look for an existing org in this tenant whose
      // normalized legal name or domain matches. Catches variations
      // like "Vector Trade Capital" vs "Vector Trade Capital LLC" and
      // "vexhq.ai" vs "www.vexhq.ai" before the insert. The DB still
      // has its own unique constraints as a last-resort net.
      const duplicate = await this.organizations.findByNormalizedIdentity(
        tx,
        input.legalName,
        input.domain ?? null,
      );
      if (duplicate) {
        throw new ConflictException({
          message: `organization ${input.legalName} already exists`,
          existingOrganizationId: duplicate.id,
        });
      }
      try {
        const row = await this.organizations.create(tx, tenantId, {
          id,
          legalName: input.legalName,
          ...(input.domain ? { domain: input.domain } : {}),
          ...(input.industry ? { industry: input.industry } : {}),
        });
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
    return {
      organization: {
        id: organization.id,
        legalName: organization.legalName,
        domain: organization.domain,
        industry: organization.industry,
        fitScore: organization.fitScore,
        status: organization.status,
        contactCount: 0,
        createdAt: organization.createdAt.toISOString(),
        updatedAt: organization.updatedAt.toISOString(),
      },
    };
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
      // endpoint shape the UI already renders.
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
        .where(eq(schema.contactOrgMemberships.orgId, id))
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
          .where(eq(schema.contactOrgMemberships.orgId, id))
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
        };
        return detail;
      },
    );
    if (!organization)
      throw new NotFoundException(`organization ${id} not found`);
    return { organization };
  }
}

function clampLimit(raw: string | undefined, fallback: number, max: number): number {
  const parsed = raw ? Number.parseInt(raw, 10) : fallback;
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.min(parsed, max);
}

async function loadContactCounts(tx: Tx): Promise<Map<string, number>> {
  // Count via the m:n memberships table so a contact shared across
  // multiple orgs counts once per org it belongs to.
  const rows = await tx
    .select({
      orgId: schema.contactOrgMemberships.orgId,
      count: count(),
    })
    .from(schema.contactOrgMemberships)
    .groupBy(schema.contactOrgMemberships.orgId);
  const out = new Map<string, number>();
  for (const r of rows) out.set(r.orgId, Number(r.count));
  return out;
}
