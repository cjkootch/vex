import { sql } from "drizzle-orm";
import type { Db, Tx } from "./client.js";

/**
 * Run a callback inside a Postgres transaction with `app.tenant_id` set to
 * the given value. Every query the callback makes through `tx` is then
 * row-level-security filtered against this tenant.
 *
 * Implementation notes:
 *   - We use `set_config(..., true)` — equivalent to `SET LOCAL` but
 *     parameter-safe. The value disappears at COMMIT/ROLLBACK; session
 *     state never leaks across pooler connection reuses.
 *   - The Drizzle neon-http driver batches transaction statements into a
 *     single HTTP request that runs as one Postgres transaction, so the
 *     setting persists for the rest of the callback.
 *   - The callback receives a `Tx`, not `Db`, so callers can't accidentally
 *     escape the transaction by reaching for the parent client.
 */
export async function withTenant<T>(
  db: Db,
  tenantId: string,
  fn: (tx: Tx) => Promise<T>,
): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT set_config('app.tenant_id', ${tenantId}, true)`);
    return fn(tx);
  });
}

/** Alias kept for callers written against the Sprint 0 placeholder API. */
export type TenantScopedDb = Tx;
