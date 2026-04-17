import {
  Controller,
  Get,
  Inject,
  NotFoundException,
  Param,
  Query,
  UseGuards,
} from "@nestjs/common";
import { count, desc, eq } from "drizzle-orm";
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

export interface OrganizationDetail extends OrganizationListRow {
  sourceOfTruth: string | null;
  externalKeys: Record<string, string>;
  contacts: OrganizationContactSummary[];
}

const STATUS_VALUES = new Set<RecordStatus>([
  "active",
  "archived",
  "inactive",
]);

@Controller("organizations")
@UseGuards(JwtAuthGuard)
export class OrganizationsController {
  constructor(
    @Inject(TenantContext) private readonly tenant: TenantContext,
    @Inject(ORGANIZATIONS_DB_CLIENT) private readonly db: Db,
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

        const contacts = await tx
          .select()
          .from(schema.contacts)
          .where(eq(schema.contacts.orgId, id))
          .orderBy(desc(schema.contacts.updatedAt))
          .limit(200);

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
  const rows = await tx
    .select({ orgId: schema.contacts.orgId, count: count() })
    .from(schema.contacts)
    .groupBy(schema.contacts.orgId);
  const out = new Map<string, number>();
  for (const r of rows) out.set(r.orgId, Number(r.count));
  return out;
}
