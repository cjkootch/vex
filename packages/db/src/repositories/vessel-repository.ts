import { and, asc, eq } from "drizzle-orm";
import { createId } from "@vex/domain";
import type { Tx } from "../client.js";
import { vessels, type Vessel } from "../schema/vessels.js";
import type { VesselClass } from "../schema/enums.js";

/**
 * VesselRepository — CRUD over the `vessels` dimension table (0019).
 *
 * Stateless. Every read/write takes a `Tx` opened by `withTenant` so RLS
 * scopes the query by `app.tenant_id`. Inserts also take an explicit
 * `tenantId` because the WITH CHECK policy requires the column to match
 * the session value.
 */

export interface VesselCreate {
  name: string;
  vesselClass: VesselClass;
  imoNumber?: string | null;
  flag?: string | null;
  dwtMt?: number | null;
  loaM?: number | null;
  beamM?: number | null;
  maxDraftM?: number | null;
  builtYear?: number | null;
  operatorOrgId?: string | null;
  iceClass?: string | null;
  doubleHull?: boolean;
  lastPscInspectionDate?: string | null;
  lastPscDeficiencies?: number | null;
  notes?: string | null;
  /** Explicit id — used by seed / fixture code. */
  id?: string;
}

/**
 * Patch shape for {@link VesselRepository.update}. Every field is optional
 * — the controller / agent only writes columns that made it into the
 * validated payload, so a partial patch can't clobber untouched fields.
 */
export type VesselUpdate = Partial<{
  name: string;
  vesselClass: VesselClass;
  imoNumber: string | null;
  flag: string | null;
  dwtMt: number | null;
  loaM: number | null;
  beamM: number | null;
  maxDraftM: number | null;
  builtYear: number | null;
  operatorOrgId: string | null;
  iceClass: string | null;
  doubleHull: boolean;
  lastPscInspectionDate: string | null;
  lastPscDeficiencies: number | null;
  notes: string | null;
}>;

export interface VesselListFilter {
  vesselClass?: VesselClass;
  /** Cap rows. Defaults to 200 to keep list views snappy. */
  limit?: number;
}

export class VesselRepository {
  async findById(tx: Tx, id: string): Promise<Vessel | null> {
    const [row] = await tx
      .select()
      .from(vessels)
      .where(eq(vessels.id, id))
      .limit(1);
    return row ?? null;
  }

  /**
   * Lookup by IMO. RLS already scopes to the tenant, but we still take
   * the IMO as the unique handle since two tenants could each carry the
   * same hull (the partial unique index is per-tenant).
   */
  async findByImo(tx: Tx, imoNumber: string): Promise<Vessel | null> {
    const trimmed = imoNumber.trim();
    if (!trimmed) return null;
    const [row] = await tx
      .select()
      .from(vessels)
      .where(eq(vessels.imoNumber, trimmed))
      .limit(1);
    return row ?? null;
  }

  /** Listed alphabetically by name — the natural surface for picker UIs. */
  async list(tx: Tx, filter: VesselListFilter = {}): Promise<Vessel[]> {
    const limit = Math.min(filter.limit ?? 200, 500);
    const clauses = filter.vesselClass
      ? eq(vessels.vesselClass, filter.vesselClass)
      : undefined;
    const base = tx.select().from(vessels);
    const filtered = clauses ? base.where(clauses) : base;
    return filtered.orderBy(asc(vessels.name)).limit(limit);
  }

  async create(tx: Tx, tenantId: string, data: VesselCreate): Promise<Vessel> {
    const [row] = await tx
      .insert(vessels)
      .values({
        id: data.id ?? createId(),
        tenantId,
        name: data.name,
        vesselClass: data.vesselClass,
        imoNumber: data.imoNumber ?? null,
        flag: data.flag ?? null,
        dwtMt: data.dwtMt ?? null,
        loaM: data.loaM ?? null,
        beamM: data.beamM ?? null,
        maxDraftM: data.maxDraftM ?? null,
        builtYear: data.builtYear ?? null,
        operatorOrgId: data.operatorOrgId ?? null,
        iceClass: data.iceClass ?? null,
        // Pass through `undefined` so the column default (true) wins on
        // create when the caller doesn't have a hull-type opinion yet.
        ...(data.doubleHull !== undefined ? { doubleHull: data.doubleHull } : {}),
        lastPscInspectionDate: data.lastPscInspectionDate ?? null,
        lastPscDeficiencies: data.lastPscDeficiencies ?? null,
        notes: data.notes ?? null,
      })
      .returning();
    if (!row) throw new Error("vessels insert returned no row");
    return row;
  }

  /**
   * Idempotent upsert by IMO. When the IMO already exists in this
   * tenant, returns the existing row unchanged (the partial unique
   * index on (tenant_id, imo_number) catches the duplicate at the DB
   * level). Otherwise creates a new vessel. Useful for ingestion
   * paths where vessel particulars arrive in pieces.
   */
  async upsertByImo(
    tx: Tx,
    tenantId: string,
    data: VesselCreate & { imoNumber: string },
  ): Promise<{ kind: "created" | "existing"; vessel: Vessel }> {
    const existing = await this.findByImo(tx, data.imoNumber);
    if (existing) return { kind: "existing", vessel: existing };
    const vessel = await this.create(tx, tenantId, data);
    return { kind: "created", vessel };
  }

  /**
   * Patch a vessel. Only writes columns present in `patch`; never
   * clobbers untouched fields. Always bumps `updated_at` so listings
   * sorted by recency surface the latest edits first.
   */
  async update(tx: Tx, id: string, patch: VesselUpdate): Promise<Vessel> {
    const set: Record<string, unknown> = { updatedAt: new Date() };
    for (const [key, value] of Object.entries(patch)) {
      if (value !== undefined) set[key] = value;
    }
    const [row] = await tx
      .update(vessels)
      .set(set)
      .where(eq(vessels.id, id))
      .returning();
    if (!row) throw new Error(`vessels ${id} not found`);
    return row;
  }

  /**
   * Vessels operated by a given organization. Joins for the
   * organization detail page's "Fleet" panel — RLS scopes the query
   * so cross-tenant operators don't leak.
   */
  async listByOperator(tx: Tx, operatorOrgId: string): Promise<Vessel[]> {
    return tx
      .select()
      .from(vessels)
      .where(
        and(
          eq(vessels.operatorOrgId, operatorOrgId),
        ),
      )
      .orderBy(asc(vessels.name));
  }
}
