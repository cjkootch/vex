import { and, desc, eq } from "drizzle-orm";
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
