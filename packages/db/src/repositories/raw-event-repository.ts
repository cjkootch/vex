import { and, eq } from "drizzle-orm";
import { createId } from "@vex/domain";
import type { Db } from "../client.js";
import { rawEvents } from "../schema/raw-events.js";

export class RawEventRepository {
  constructor(private readonly db: Db) {}

  /**
   * Idempotent insert. Returns the existing id if `(tenantId, provider,
   * providerEventId)` already exists, otherwise inserts a new row and returns
   * its id. The uniqueness constraint is enforced at the DB layer; this method
   * short-circuits on an in-memory lookup to avoid unique-violation errors in
   * the hot path.
   */
  async insertIfNotExists(
    tenantId: string,
    provider: string,
    providerEventId: string,
    headers: Record<string, unknown>,
    payload: Record<string, unknown>,
    checksum: string | null,
    receivedAt: Date = new Date(),
  ): Promise<{ id: string; isNew: boolean }> {
    const [existing] = await this.db
      .select({ id: rawEvents.id })
      .from(rawEvents)
      .where(
        and(
          eq(rawEvents.tenantId, tenantId),
          eq(rawEvents.provider, provider),
          eq(rawEvents.providerEventId, providerEventId),
        ),
      )
      .limit(1);

    if (existing) return { id: existing.id, isNew: false };

    const id = createId();
    await this.db.insert(rawEvents).values({
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
}
