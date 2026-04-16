import { eq } from "drizzle-orm";
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
}
