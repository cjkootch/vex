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
  UseGuards,
} from "@nestjs/common";
import { count, desc, eq, or } from "drizzle-orm";
import { z } from "zod";
import { createId } from "@vex/domain";
import type {
  EventRepository,
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
  kind: string | null;
  contactCount: number;
  productCount: number;
  dealCount: number;
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
    @Inject(ORGANIZATIONS_PRODUCTS_REPO)
    private readonly orgProducts: OrganizationProductRepository,
    @Inject(ORGANIZATIONS_RELATIONSHIPS_REPO)
    private readonly orgRelationships: OrganizationRelationshipRepository,
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
        const [contactCounts, productCounts, dealCounts] = await Promise.all([
          loadContactCounts(tx),
          loadProductCounts(tx),
          loadBuyerDealCounts(tx),
        ]);

        return rows.map((row) => ({
          id: row.id,
          legalName: row.legalName,
          domain: row.domain,
          industry: row.industry,
          fitScore: row.fitScore,
          status: row.status,
          kind: row.kind,
          contactCount: contactCounts.get(row.id) ?? 0,
          productCount: productCounts.get(row.id) ?? 0,
          dealCount: dealCounts.get(row.id) ?? 0,
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
    return {
      organization: {
        id: organization.id,
        legalName: organization.legalName,
        domain: organization.domain,
        industry: organization.industry,
        fitScore: organization.fitScore,
        status: organization.status,
        kind: organization.kind ?? null,
        contactCount: 0,
        productCount: 0,
        dealCount: 0,
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

      const productRows = await this.orgProducts.listForOrg(tx, id);

      const detail: OrganizationDetail = {
        id: after.id,
        legalName: after.legalName,
        domain: after.domain,
        industry: after.industry,
        fitScore: after.fitScore,
        status: after.status,
        kind: after.kind ?? null,
        sourceOfTruth: after.sourceOfTruth,
        externalKeys: after.externalKeys,
        contactCount: contacts.length,
        productCount: productRows.length,
        dealCount: deals.length,
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

        const productRows = await this.orgProducts.listForOrg(tx, id);

        const detail: OrganizationDetail = {
          id: row.id,
          legalName: row.legalName,
          domain: row.domain,
          industry: row.industry,
          fitScore: row.fitScore,
          status: row.status,
          kind: row.kind ?? null,
          sourceOfTruth: row.sourceOfTruth,
          externalKeys: row.externalKeys,
          contactCount: contacts.length,
          productCount: productRows.length,
          dealCount: deals.length,
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

  // -------------------------------------------------------------------
  // Sprint W — products + broker/supplier relationships
  // -------------------------------------------------------------------

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

async function loadProductCounts(tx: Tx): Promise<Map<string, number>> {
  const rows = await tx
    .select({
      orgId: schema.organizationProducts.orgId,
      count: count(),
    })
    .from(schema.organizationProducts)
    .groupBy(schema.organizationProducts.orgId);
  const out = new Map<string, number>();
  for (const r of rows) out.set(r.orgId, Number(r.count));
  return out;
}

async function loadBuyerDealCounts(tx: Tx): Promise<Map<string, number>> {
  const rows = await tx
    .select({
      orgId: schema.fuelDeals.buyerOrgId,
      count: count(),
    })
    .from(schema.fuelDeals)
    .groupBy(schema.fuelDeals.buyerOrgId);
  const out = new Map<string, number>();
  for (const r of rows) out.set(r.orgId, Number(r.count));
  return out;
}
