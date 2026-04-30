import { and, desc, eq, lt, sql, type SQL } from "drizzle-orm";
import { createId } from "@vex/domain";
import type { Tx } from "../client.js";
import { events, type Event } from "../schema/events.js";

export interface EventInsert {
  verb: string;
  subjectType: string;
  subjectId: string;
  actorType?: string | null;
  actorId?: string | null;
  objectType?: string | null;
  objectId?: string | null;
  occurredAt: Date;
  idempotencyKey: string;
  metadata?: Record<string, unknown>;
}

export class EventRepository {
  /**
   * Insert if no event with the same `idempotencyKey` exists in the current
   * tenant scope. Mirrors the dedupe behaviour of
   * {@link RawEventRepository.insertIfNotExists}.
   */
  async insertIfNotExists(
    tx: Tx,
    tenantId: string,
    data: EventInsert,
  ): Promise<{ event: Event; isNew: boolean }> {
    const [existing] = await tx
      .select()
      .from(events)
      .where(eq(events.idempotencyKey, data.idempotencyKey))
      .limit(1);

    if (existing) return { event: existing, isNew: false };

    const [row] = await tx
      .insert(events)
      .values({
        id: createId(),
        tenantId,
        verb: data.verb,
        subjectType: data.subjectType,
        subjectId: data.subjectId,
        actorType: data.actorType ?? null,
        actorId: data.actorId ?? null,
        objectType: data.objectType ?? null,
        objectId: data.objectId ?? null,
        occurredAt: data.occurredAt,
        idempotencyKey: data.idempotencyKey,
        metadata: data.metadata ?? {},
      })
      .returning();
    if (!row) throw new Error("event insert returned no row");
    return { event: row, isNew: true };
  }

  /**
   * Newest-first event timeline for a single subject (e.g. all rows
   * with subject_type="fuel_deal" + subject_id=<dealId>). Used by
   * the deal detail page's milestone timeline.
   */
  async listBySubject(
    tx: Tx,
    subjectType: string,
    subjectId: string,
    limit = 100,
  ): Promise<Event[]> {
    return tx
      .select()
      .from(events)
      .where(
        and(
          eq(events.subjectType, subjectType),
          eq(events.subjectId, subjectId),
        ),
      )
      .orderBy(desc(events.occurredAt))
      .limit(limit);
  }

  /**
   * Find the most recent `approval.executor.applied` event whose
   * metadata carries the given Resend / Twilio provider message id.
   * Used by the Resend `email.delivered` webhook handler to find the
   * approval that produced an outbound email so the chat chip can
   * flip from "applied" → "delivered". Returns null when no apply
   * event matches — caller fail-soft skips the linkage.
   *
   * Scoped by RLS to the current tenant via the open `Tx`.
   */
  async findApplyByProviderMessageId(
    tx: Tx,
    providerMessageId: string,
  ): Promise<Event | null> {
    const [row] = await tx
      .select()
      .from(events)
      .where(
        and(
          eq(events.verb, "approval.executor.applied"),
          sql`${events.metadata}->>'provider_message_id' = ${providerMessageId}`,
        ),
      )
      .orderBy(desc(events.occurredAt))
      .limit(1);
    return row ?? null;
  }

  /**
   * Newest-first events matching a verb, optionally keyset-paginated
   * by an upper bound on occurredAt. Used by the admin
   * feature-request inbox to surface chat.unsupported_request rows.
   */
  async listByVerb(
    tx: Tx,
    verb: string,
    limit = 50,
    before?: Date,
  ): Promise<Event[]> {
    const clauses: SQL[] = [eq(events.verb, verb)];
    if (before) clauses.push(lt(events.occurredAt, before));
    return tx
      .select()
      .from(events)
      .where(and(...clauses))
      .orderBy(desc(events.occurredAt))
      .limit(limit);
  }
}
