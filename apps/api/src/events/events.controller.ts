import {
  BadRequestException,
  Controller,
  Get,
  Inject,
  Query,
  UseGuards,
} from "@nestjs/common";
import { and, desc, eq, lt } from "drizzle-orm";
import { JwtAuthGuard, TenantContext } from "../auth/index.js";
import { schema, withTenant, type Db } from "@vex/db";

/**
 * GET /events — read-only audit timeline, filtered by
 * `?subject_type` + `?subject_id`. The rows come from the tenant's
 * append-only `events` table, which every mutation we ship writes to.
 * This powers the per-entity activity panels on the detail pages.
 *
 * Pagination is keyset: optional `?before` accepts an ISO timestamp
 * and returns rows strictly older than it, capped at `?limit` (default
 * 50, max 200). Ordered newest-first.
 */

export const EVENTS_DB_CLIENT = Symbol("EVENTS_DB_CLIENT");

const VALID_SUBJECT_TYPES = new Set([
  "fuel_deal",
  "organization",
  "contact",
  "lead",
  "campaign",
  "approval",
  "agent_run",
  "workspace",
]);

export interface EventRow {
  id: string;
  verb: string;
  subjectType: string;
  subjectId: string;
  actorType: string | null;
  actorId: string | null;
  objectType: string | null;
  objectId: string | null;
  occurredAt: string;
  metadata: Record<string, unknown>;
}

@Controller("events")
@UseGuards(JwtAuthGuard)
export class EventsController {
  constructor(
    @Inject(TenantContext) private readonly tenant: TenantContext,
    @Inject(EVENTS_DB_CLIENT) private readonly db: Db,
  ) {}

  @Get()
  async list(
    @Query("subject_type") subjectTypeRaw?: string,
    @Query("subject_id") subjectId?: string,
    @Query("limit") limitRaw?: string,
    @Query("before") beforeRaw?: string,
  ): Promise<{ events: EventRow[] }> {
    if (!subjectTypeRaw || !subjectId) {
      throw new BadRequestException(
        "subject_type and subject_id query params are required",
      );
    }
    if (!VALID_SUBJECT_TYPES.has(subjectTypeRaw)) {
      throw new BadRequestException(
        `subject_type '${subjectTypeRaw}' not allowed`,
      );
    }
    const limit = clampLimit(limitRaw);
    const before = parseBefore(beforeRaw);

    const rows = await withTenant(this.db, this.tenant.tenantId, async (tx) => {
      const conditions = [
        eq(schema.events.subjectType, subjectTypeRaw),
        eq(schema.events.subjectId, subjectId),
      ];
      if (before) conditions.push(lt(schema.events.occurredAt, before));
      return tx
        .select()
        .from(schema.events)
        .where(and(...conditions))
        .orderBy(desc(schema.events.occurredAt))
        .limit(limit);
    });

    return {
      events: rows.map((r) => ({
        id: r.id,
        verb: r.verb,
        subjectType: r.subjectType,
        subjectId: r.subjectId,
        actorType: r.actorType,
        actorId: r.actorId,
        objectType: r.objectType,
        objectId: r.objectId,
        occurredAt: r.occurredAt.toISOString(),
        metadata: r.metadata,
      })),
    };
  }
}

function clampLimit(raw: string | undefined): number {
  const parsed = raw ? Number.parseInt(raw, 10) : 50;
  if (!Number.isFinite(parsed) || parsed <= 0) return 50;
  return Math.min(parsed, 200);
}

function parseBefore(raw: string | undefined): Date | null {
  if (!raw) return null;
  const t = Date.parse(raw);
  return Number.isFinite(t) ? new Date(t) : null;
}
