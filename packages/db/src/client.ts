import { neon, neonConfig } from "@neondatabase/serverless";
import { drizzle } from "drizzle-orm/neon-http";
import * as schema from "./schema/index.js";

neonConfig.fetchConnectionCache = true;

/**
 * Build an application DB client backed by the Neon pooled endpoint.
 *
 * Per invariant: all runtime queries go through APPLICATION_DATABASE_URL.
 * The MIGRATION_DATABASE_URL (direct) is used only by the migration runner.
 */
export function createDb(applicationDatabaseUrl: string) {
  const sql = neon(applicationDatabaseUrl);
  return drizzle(sql, { schema });
}

export type Db = ReturnType<typeof createDb>;
