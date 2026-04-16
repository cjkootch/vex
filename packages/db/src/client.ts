import { neon, neonConfig } from "@neondatabase/serverless";
import { drizzle, type NeonHttpDatabase } from "drizzle-orm/neon-http";
import * as schema from "./schema/index.js";

neonConfig.fetchConnectionCache = true;

/**
 * Build an application DB client backed by the Neon pooled endpoint.
 *
 * Per invariant: all runtime queries go through APPLICATION_DATABASE_URL.
 * The MIGRATION_DATABASE_URL (direct) is used only by the migration runner.
 */
export function createDb(applicationDatabaseUrl: string): Db {
  const sql = neon(applicationDatabaseUrl);
  return drizzle(sql, { schema });
}

export type Db = NeonHttpDatabase<typeof schema>;

/**
 * The `tx` argument received by every callback passed to `withTenant`. Same
 * Drizzle query surface as `Db` but scoped to a single Postgres transaction.
 */
export type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];
