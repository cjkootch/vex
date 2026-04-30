import {
  BadRequestException,
  Controller,
  Get,
  Inject,
  Query,
  UseGuards,
} from "@nestjs/common";
import { and, desc, eq, lt, sql } from "drizzle-orm";
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
 *
 * For `subject_type=contact` we ALSO fold in two adjacent stores so
 * the contact's Activity tab shows the comms history operators
 * actually want to see:
 *
 *   1. `touchpoints` keyed by `contact_id` — every email.sent /
 *      email.received / sms.sent / whatsapp.sent the workspace
 *      records goes here. The send executors stamp these but only
 *      emit an `approval.executor.applied` event (subjectType
 *      "approval"), so the contact-scoped events query alone misses
 *      the outbound side. Synthesize a matching event row from each
 *      touchpoint.
 *   2. `activities` of type `voice_call` whose
 *      `related_object_ids.contact_id` matches — completed calls
 *      stamp an `activities` row (transcript_ref, duration, recording
 *      storage key) but the `call.completed` audit event uses
 *      subjectType "activity". Surface them as `call.completed`
 *      timeline rows so the operator sees the call without bouncing
 *      to /app/calls.
 *
 * Synthesised rows carry `id` prefixes (`tp:` / `act:`) so they don't
 * collide with real event ids in the React keyed list, and the merge
 * is done in JS after each store is queried with the same `before`
 * cursor + limit so a single small contact returns ≤3*limit rows
 * pre-trim. Trim happens after merge so a busy comms history doesn't
 * starve out a recent profile-edit event.
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

    const merged = await withTenant(this.db, this.tenant.tenantId, async (tx) => {
      const conditions = [
        eq(schema.events.subjectType, subjectTypeRaw),
        eq(schema.events.subjectId, subjectId),
      ];
      if (before) conditions.push(lt(schema.events.occurredAt, before));
      const eventRows = await tx
        .select()
        .from(schema.events)
        .where(and(...conditions))
        .orderBy(desc(schema.events.occurredAt))
        .limit(limit);

      const fromEvents: EventRow[] = eventRows.map((r) => ({
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
      }));

      if (subjectTypeRaw !== "contact") return fromEvents;

      // Contact-only fold-in: touchpoints + voice_call activities.
      const tpClauses = [eq(schema.touchpoints.contactId, subjectId)];
      if (before) tpClauses.push(lt(schema.touchpoints.occurredAt, before));
      const tpRows = await tx
        .select()
        .from(schema.touchpoints)
        .where(and(...tpClauses))
        .orderBy(desc(schema.touchpoints.occurredAt))
        .limit(limit);

      const fromTouchpoints: EventRow[] = tpRows.map((tp) => ({
        // Prefix so synthesised ids never collide with real event ids
        // in the React keyed list.
        id: `tp:${tp.id}`,
        // The touchpoint's `channel` already follows the
        // "<medium>.<direction>" convention the timeline UI's
        // VERB_LABELS map keys on (`email.sent`, `sms.received`, …).
        verb: tp.channel,
        subjectType: "contact",
        subjectId: subjectId,
        actorType:
          (tp.metadata as Record<string, unknown> | null)?.["direction"] ===
          "inbound"
            ? "contact"
            : "system",
        actorId: tp.actor,
        objectType: "touchpoint",
        objectId: tp.id,
        occurredAt: tp.occurredAt.toISOString(),
        metadata: tp.metadata,
      }));

      const actClauses = [
        eq(schema.activities.type, "voice_call"),
        sql`${schema.activities.relatedObjectIds} ->> 'contact_id' = ${subjectId}`,
      ];
      if (before) actClauses.push(lt(schema.activities.occurredAt, before));
      const actRows = await tx
        .select()
        .from(schema.activities)
        .where(and(...actClauses))
        .orderBy(desc(schema.activities.occurredAt))
        .limit(limit);

      const fromActivities: EventRow[] = actRows.map((act) => {
        const md = (act.metadata ?? {}) as Record<string, unknown>;
        const callMetadata: Record<string, unknown> = {
          ...md,
          duration_seconds:
            act.durationSeconds ?? md["duration_seconds"] ?? null,
          activity_id: act.id,
          // Pass the recording storage key through so the timeline UI
          // can render a "play recording" link without a second fetch.
          ...(act.transcriptRef
            ? { transcript_ref: act.transcriptRef }
            : {}),
        };
        return {
          id: `act:${act.id}`,
          verb: "call.completed",
          subjectType: "contact",
          subjectId: subjectId,
          actorType: "system",
          actorId: null,
          objectType: "activity",
          objectId: act.id,
          occurredAt: act.occurredAt.toISOString(),
          metadata: callMetadata,
        };
      });

      // Merge + newest-first sort + trim. Ties on occurredAt fall
      // back to the synthesised id so order is deterministic between
      // requests (BullMQ retries, integration tests).
      return [...fromEvents, ...fromTouchpoints, ...fromActivities]
        .sort((a, b) => {
          if (a.occurredAt !== b.occurredAt)
            return a.occurredAt < b.occurredAt ? 1 : -1;
          return a.id < b.id ? 1 : -1;
        })
        .slice(0, limit);
    });

    return { events: merged };
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
