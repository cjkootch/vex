import {
  BadRequestException,
  Controller,
  Get,
  Inject,
  Query,
  UseGuards,
} from "@nestjs/common";
import { desc, ilike, or } from "drizzle-orm";
import { JwtAuthGuard, TenantContext } from "../auth/index.js";
import { schema, withTenant, type Db } from "@vex/db";

/**
 * GET /search?q=<query>&limit=8 — unified entity lookup for the
 * ⌘K command palette. Runs a tenant-scoped ILIKE across
 * organizations.legal_name, contacts.full_name, and
 * fuel_deals.deal_ref. Returns a flat, bounded list tagged by kind.
 *
 * Cheap on purpose — no embeddings, no scoring. The palette is a
 * navigation primitive, not a retrieval primitive. (Chat still uses
 * the RetrievalService + embeddings pipeline.)
 */

export const SEARCH_DB_CLIENT = Symbol("SEARCH_DB_CLIENT");

export interface SearchHit {
  kind: "organization" | "contact" | "deal";
  id: string;
  label: string;
  sublabel: string | null;
}

@Controller("search")
@UseGuards(JwtAuthGuard)
export class SearchController {
  constructor(
    @Inject(TenantContext) private readonly tenant: TenantContext,
    @Inject(SEARCH_DB_CLIENT) private readonly db: Db,
  ) {}

  @Get()
  async search(
    @Query("q") qRaw?: string,
    @Query("limit") limitRaw?: string,
  ): Promise<{ hits: SearchHit[] }> {
    const q = (qRaw ?? "").trim();
    if (q.length < 2) {
      throw new BadRequestException("q must be at least 2 characters");
    }
    const perKindLimit = clampLimit(limitRaw, 8, 20);
    const pattern = `%${q.replace(/[%_]/g, (ch) => `\\${ch}`)}%`;

    const hits = await withTenant(this.db, this.tenant.tenantId, async (tx) => {
      const [orgs, contacts, deals] = await Promise.all([
        tx
          .select({
            id: schema.organizations.id,
            legalName: schema.organizations.legalName,
            domain: schema.organizations.domain,
          })
          .from(schema.organizations)
          .where(
            or(
              ilike(schema.organizations.legalName, pattern),
              ilike(schema.organizations.domain, pattern),
            ),
          )
          .orderBy(desc(schema.organizations.updatedAt))
          .limit(perKindLimit),
        tx
          .select({
            id: schema.contacts.id,
            fullName: schema.contacts.fullName,
            title: schema.contacts.title,
          })
          .from(schema.contacts)
          .where(ilike(schema.contacts.fullName, pattern))
          .orderBy(desc(schema.contacts.updatedAt))
          .limit(perKindLimit),
        tx
          .select({
            id: schema.fuelDeals.id,
            dealRef: schema.fuelDeals.dealRef,
            status: schema.fuelDeals.status,
          })
          .from(schema.fuelDeals)
          .where(ilike(schema.fuelDeals.dealRef, pattern))
          .orderBy(desc(schema.fuelDeals.createdAt))
          .limit(perKindLimit),
      ]);

      const out: SearchHit[] = [];
      for (const o of orgs) {
        out.push({
          kind: "organization",
          id: o.id,
          label: o.legalName,
          sublabel: o.domain,
        });
      }
      for (const c of contacts) {
        out.push({
          kind: "contact",
          id: c.id,
          label: c.fullName,
          sublabel: c.title,
        });
      }
      for (const d of deals) {
        out.push({
          kind: "deal",
          id: d.id,
          label: d.dealRef,
          sublabel: d.status,
        });
      }
      return out;
    });

    return { hits };
  }
}

function clampLimit(raw: string | undefined, fallback: number, max: number): number {
  const parsed = raw ? Number.parseInt(raw, 10) : fallback;
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.min(parsed, max);
}
