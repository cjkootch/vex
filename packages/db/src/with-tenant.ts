import { sql } from "drizzle-orm";
import type { TenantId } from "@vex/domain";
import type { Db } from "./client.js";

export type TenantScopedDb = Db;

/**
 * Run a callback with the session variable `app.tenant_id` set to the given
 * tenant. Row-level security policies (enabled in Sprint 3) will use this
 * session variable to constrain reads and writes.
 *
 * Per invariant "All DB writes use withTenant(db, tenantId, fn)" — do not call
 * raw queries from app code; always go through this helper so the tenant guard
 * is always in scope.
 *
 * Until Sprint 3 lands the RLS policies the helper still sets the session var
 * so callers are written against the final API surface.
 */
export async function withTenant<T>(
  db: Db,
  tenantId: TenantId,
  fn: (scoped: TenantScopedDb) => Promise<T>,
): Promise<T> {
  await db.execute(sql`SET LOCAL app.tenant_id = ${tenantId}`);
  return fn(db);
}
