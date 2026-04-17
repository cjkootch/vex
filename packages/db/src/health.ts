import { sql } from "drizzle-orm";
import type { Db } from "./client.js";

/**
 * Run the lightest possible query so the health endpoint can verify the
 * pool is reachable and the tenant RLS extension is loaded. Returns
 * silently on success; throws the driver error on failure.
 */
export async function pingDb(db: Db): Promise<void> {
  await db.execute(sql`SELECT 1`);
}
