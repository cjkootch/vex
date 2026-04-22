import { createHash } from "node:crypto";
import { and, desc, eq, sql } from "drizzle-orm";
import { createId } from "@vex/domain";
import type { Tx } from "../client.js";
import { rawEvents, type RawEvent } from "../schema/raw-events.js";

export type RawEventStatus = "pending" | "processed" | "failed";

/**
 * Stateless. Inserts take an explicit `tenantId` so RLS WITH CHECK passes;
 * reads/updates are filtered by the policy via `app.tenant_id`.
 */
export class RawEventRepository {
  /**
   * Idempotent insert. Returns the existing id if `(tenantId, provider,
   * providerEventId)` already exists, otherwise inserts a new row.
   *
   * Race safety: raw_events is RANGE-partitioned by `received_at`, so
   * Postgres requires `received_at` to be part of every unique index
   * on the table. That means the physical unique index
   * `(received_at, tenant_id, provider, provider_event_id)` doesn't
   * actually enforce our logical dedupe key — two concurrent retries
   * with different `received_at` both pass the existence check and
   * both insert.
   *
   * Fix: wrap the check-then-insert in a `pg_advisory_xact_lock` keyed
   * off `(tenantId, provider, providerEventId)`. The lock linearises
   * concurrent callers for that one event; the second call re-checks
   * under the lock and short-circuits to the first row. Lock releases
   * automatically at transaction commit/rollback.
   */
  async insertIfNotExists(
    tx: Tx,
    tenantId: string,
    provider: string,
    providerEventId: string,
    headers: Record<string, unknown>,
    payload: Record<string, unknown>,
    checksum: string | null,
    receivedAt: Date = new Date(),
  ): Promise<{ id: string; isNew: boolean }> {
    const [lockA, lockB] = advisoryLockKeys(
      `${tenantId}:${provider}:${providerEventId}`,
    );
    await tx.execute(sql`SELECT pg_advisory_xact_lock(${lockA}, ${lockB})`);

    const [existing] = await tx
      .select({ id: rawEvents.id })
      .from(rawEvents)
      .where(
        and(
          eq(rawEvents.provider, provider),
          eq(rawEvents.providerEventId, providerEventId),
        ),
      )
      .limit(1);

    if (existing) return { id: existing.id, isNew: false };

    const id = createId();
    await tx.insert(rawEvents).values({
      id,
      tenantId,
      provider,
      providerEventId,
      headers,
      payload,
      checksum,
      receivedAt,
    });
    return { id, isNew: true };
  }

  async findById(tx: Tx, id: string): Promise<RawEvent | null> {
    const rows = await tx.select().from(rawEvents).where(eq(rawEvents.id, id));
    return rows[0] ?? null;
  }

  async updateStatus(tx: Tx, id: string, status: RawEventStatus): Promise<void> {
    await tx.update(rawEvents).set({ status }).where(eq(rawEvents.id, id));
  }

  async listFailed(tx: Tx, limit = 100): Promise<RawEvent[]> {
    return tx
      .select()
      .from(rawEvents)
      .where(eq(rawEvents.status, "failed"))
      .orderBy(desc(rawEvents.receivedAt))
      .limit(limit);
  }
}

/**
 * Split a composite lock key into two int4s for
 * `pg_advisory_xact_lock(int4, int4)`. Splits a SHA-256 into the first
 * 8 bytes and reads two signed 32-bit ints. Collisions across distinct
 * keys are harmless here — a collision means two unrelated events
 * serialise together for a moment; correctness holds because the
 * under-lock re-check still short-circuits on the right row.
 */
export function advisoryLockKeys(composite: string): [number, number] {
  const digest = createHash("sha256").update(composite).digest();
  const a = digest.readInt32BE(0);
  const b = digest.readInt32BE(4);
  return [a, b];
}
