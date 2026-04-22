import { and, asc, desc, eq, gt, isNull, or, sql } from "drizzle-orm";
import { createId } from "@vex/domain";
import type { Tx } from "../client.js";
import { ports, type Port } from "../schema/ports.js";
import {
  portEvents,
  type NewPortEvent,
  type PortEvent,
} from "../schema/port-events.js";

/**
 * PortRepository — CRUD + event log over the ports dimension (0020).
 *
 * Stateless. Every read/write takes a `Tx` from `withTenant` so RLS
 * scopes the query by `app.tenant_id`; inserts also take an explicit
 * `tenantId` because the WITH CHECK policy requires the column to
 * match the session value.
 *
 * Coexists with the legacy text `origin_port` / `destination_port`
 * columns on fuel_deals — the ULID-linked FKs on fuel_deals
 * (`origin_port_id`, `destination_port_id`) are resolved through
 * this repo.
 */

export interface PortCreate {
  unlocode: string;
  name: string;
  countryCode: string;
  region: string;
  lat?: number | null;
  lng?: number | null;
  maxDraftM?: number | null;
  maxLoaM?: number | null;
  maxBeamM?: number | null;
  maxDwtMt?: number | null;
  fuelTerminal?: boolean;
  containerTerminal?: boolean;
  bulkTerminal?: boolean;
  reeferCapable?: boolean;
  customsClearanceDaysMedian?: number | null;
  portDaysMedian?: number | null;
  congestionFactor?: number;
  tariffNotes?: string | null;
  restrictedCargoNotes?: string | null;
  workingHours?: string | null;
  pilotageRequired?: boolean;
  localAgentOrgId?: string | null;
  lastVerifiedAt?: Date | null;
  sourceReferences?: Array<string | Record<string, unknown>>;
  /** Explicit id — used by seed / fixture code. */
  id?: string;
}

export type PortUpdate = Partial<{
  name: string;
  countryCode: string;
  region: string;
  lat: number | null;
  lng: number | null;
  maxDraftM: number | null;
  maxLoaM: number | null;
  maxBeamM: number | null;
  maxDwtMt: number | null;
  fuelTerminal: boolean;
  containerTerminal: boolean;
  bulkTerminal: boolean;
  reeferCapable: boolean;
  customsClearanceDaysMedian: number | null;
  portDaysMedian: number | null;
  congestionFactor: number;
  tariffNotes: string | null;
  restrictedCargoNotes: string | null;
  workingHours: string | null;
  pilotageRequired: boolean;
  localAgentOrgId: string | null;
  lastVerifiedAt: Date | null;
  sourceReferences: Array<string | Record<string, unknown>>;
}>;

export interface PortEventInsert {
  portId: string;
  eventType: string;
  severity?: "info" | "warn" | "critical";
  startsAt: Date;
  endsAt?: Date | null;
  title: string;
  body?: string | null;
  sourceUrl?: string | null;
  /** Explicit id — used by seed / fixture code. */
  id?: string;
}

export class PortRepository {
  async findById(tx: Tx, id: string): Promise<Port | null> {
    const [row] = await tx
      .select()
      .from(ports)
      .where(eq(ports.id, id))
      .limit(1);
    return row ?? null;
  }

  /**
   * Lookup by UN/LOCODE. RLS scopes by tenant; uniqueness is enforced
   * at (tenant, unlocode) so the response is 0 or 1 row.
   */
  async findByUnlocode(tx: Tx, unlocode: string): Promise<Port | null> {
    const trimmed = unlocode.trim().toUpperCase();
    if (!trimmed) return null;
    const [row] = await tx
      .select()
      .from(ports)
      .where(eq(ports.unlocode, trimmed))
      .limit(1);
    return row ?? null;
  }

  /**
   * Resolve a free-form ref → port. Tries in order:
   *   1. UN/LOCODE exact (5 chars upper) — "JMKIN" → Kingston
   *   2. ULID exact — direct id lookup
   *   3. Name ILIKE — "Kingston" → row whose name contains "kingston"
   *
   * Used by the chat-driven port.show flow where the user may type
   * either a well-known LOCODE or the city name. Returns the first
   * hit; callers can use `listByName` if they need multiple matches.
   */
  async findByRef(tx: Tx, ref: string): Promise<Port | null> {
    const trimmed = ref.trim();
    if (!trimmed) return null;
    if (/^[A-Z0-9]{5}$/i.test(trimmed)) {
      const byLocode = await this.findByUnlocode(tx, trimmed);
      if (byLocode) return byLocode;
    }
    if (/^[0-9A-Z]{26}$/.test(trimmed)) {
      const byId = await this.findById(tx, trimmed);
      if (byId) return byId;
    }
    const [row] = await tx
      .select()
      .from(ports)
      .where(sql`${ports.name} ILIKE ${"%" + trimmed + "%"}`)
      .orderBy(asc(ports.name))
      .limit(1);
    return row ?? null;
  }

  /**
   * Alphabetical by name — the natural surface for picker UIs and for
   * the admin ports table. Uses the region index from the migration.
   */
  async listByRegion(
    tx: Tx,
    region: string,
    limit = 200,
  ): Promise<Port[]> {
    return tx
      .select()
      .from(ports)
      .where(eq(ports.region, region))
      .orderBy(asc(ports.name))
      .limit(Math.min(limit, 500));
  }

  /** Every port in the tenant, alphabetical. For the admin table. */
  async listAll(tx: Tx, limit = 500): Promise<Port[]> {
    return tx
      .select()
      .from(ports)
      .orderBy(asc(ports.name))
      .limit(Math.min(limit, 2000));
  }

  /**
   * "Active" port events — currently happening. Defined as
   * `ends_at IS NULL` (ongoing indefinitely) OR
   * `ends_at > now()` (future-dated closure still in effect).
   *
   * Optional `portId` narrows to one port. The partial index from the
   * migration only covers the IS NULL arm; the OR branch falls back
   * to the `(port_id, starts_at DESC)` index which is still efficient
   * for the per-port query path.
   */
  async listActiveEvents(
    tx: Tx,
    portId?: string,
  ): Promise<PortEvent[]> {
    const activeClause = or(
      isNull(portEvents.endsAt),
      gt(portEvents.endsAt, sql`now()`),
    );
    const scoped = portId
      ? and(eq(portEvents.portId, portId), activeClause)
      : activeClause;
    return tx
      .select()
      .from(portEvents)
      .where(scoped)
      .orderBy(desc(portEvents.startsAt))
      .limit(500);
  }

  async insertEvent(
    tx: Tx,
    tenantId: string,
    data: PortEventInsert,
  ): Promise<PortEvent> {
    const values: NewPortEvent = {
      id: data.id ?? createId(),
      tenantId,
      portId: data.portId,
      eventType: data.eventType,
      severity: data.severity ?? "info",
      startsAt: data.startsAt,
      endsAt: data.endsAt ?? null,
      title: data.title,
      body: data.body ?? null,
      sourceUrl: data.sourceUrl ?? null,
    };
    const [row] = await tx.insert(portEvents).values(values).returning();
    if (!row) throw new Error("port_events insert returned no row");
    return row;
  }

  async create(
    tx: Tx,
    tenantId: string,
    data: PortCreate,
  ): Promise<Port> {
    const [row] = await tx
      .insert(ports)
      .values({
        id: data.id ?? createId(),
        tenantId,
        unlocode: data.unlocode.trim().toUpperCase(),
        name: data.name,
        countryCode: data.countryCode.trim().toUpperCase(),
        region: data.region,
        lat: data.lat ?? null,
        lng: data.lng ?? null,
        maxDraftM: data.maxDraftM ?? null,
        maxLoaM: data.maxLoaM ?? null,
        maxBeamM: data.maxBeamM ?? null,
        maxDwtMt: data.maxDwtMt ?? null,
        // Boolean defaults live on the column — only pass through when
        // the caller has an opinion, so the migration's defaults win
        // on a partial insert.
        ...(data.fuelTerminal !== undefined
          ? { fuelTerminal: data.fuelTerminal }
          : {}),
        ...(data.containerTerminal !== undefined
          ? { containerTerminal: data.containerTerminal }
          : {}),
        ...(data.bulkTerminal !== undefined
          ? { bulkTerminal: data.bulkTerminal }
          : {}),
        ...(data.reeferCapable !== undefined
          ? { reeferCapable: data.reeferCapable }
          : {}),
        customsClearanceDaysMedian: data.customsClearanceDaysMedian ?? null,
        portDaysMedian: data.portDaysMedian ?? null,
        ...(data.congestionFactor !== undefined
          ? { congestionFactor: data.congestionFactor }
          : {}),
        tariffNotes: data.tariffNotes ?? null,
        restrictedCargoNotes: data.restrictedCargoNotes ?? null,
        workingHours: data.workingHours ?? null,
        ...(data.pilotageRequired !== undefined
          ? { pilotageRequired: data.pilotageRequired }
          : {}),
        localAgentOrgId: data.localAgentOrgId ?? null,
        lastVerifiedAt: data.lastVerifiedAt ?? null,
        ...(data.sourceReferences !== undefined
          ? { sourceReferences: data.sourceReferences }
          : {}),
      })
      .returning();
    if (!row) throw new Error("ports insert returned no row");
    return row;
  }

  /**
   * Patch a port. Only writes columns present in `patch`; never
   * clobbers untouched fields. Always bumps `updated_at` so admin
   * lists sorted by recency surface the latest edits first. When a
   * patch lands, bumping `last_verified_at` to now() is a separate
   * explicit field — edits don't auto-verify.
   */
  async update(tx: Tx, id: string, patch: PortUpdate): Promise<Port> {
    const set: Record<string, unknown> = { updatedAt: new Date() };
    for (const [key, value] of Object.entries(patch)) {
      if (value !== undefined) set[key] = value;
    }
    const [row] = await tx
      .update(ports)
      .set(set)
      .where(eq(ports.id, id))
      .returning();
    if (!row) throw new Error(`ports ${id} not found`);
    return row;
  }
}
