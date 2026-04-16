import { Pool, neonConfig } from "@neondatabase/serverless";
import { drizzle, type NeonDatabase } from "drizzle-orm/neon-serverless";
import ws from "ws";
import * as schema from "./schema/index.js";

// Node < 22 doesn't have a global WebSocket; Neon's serverless driver needs
// one for its WebSocket-to-Postgres proxy. Always set it on the server side.
const globalWs = (globalThis as { WebSocket?: unknown }).WebSocket;
if (!globalWs) {
  neonConfig.webSocketConstructor = ws;
}

/**
 * Build an application DB client backed by the Neon pooled endpoint.
 *
 * Uses the WebSocket driver (neon-serverless) rather than neon-http because
 * our RLS pattern needs real Postgres transactions — `withTenant` opens a tx
 * and runs `SET LOCAL app.tenant_id` in it before any query.
 *
 * Per invariant: all runtime queries go through APPLICATION_DATABASE_URL.
 * The MIGRATION_DATABASE_URL (direct) is used only by the migration runner.
 */
export function createDb(applicationDatabaseUrl: string): Db {
  const pool = new Pool({ connectionString: applicationDatabaseUrl });
  return drizzle(pool, { schema });
}

export type Db = NeonDatabase<typeof schema>;

/**
 * The `tx` argument received by every callback passed to `withTenant`. Same
 * Drizzle query surface as `Db` but scoped to a single Postgres transaction.
 */
export type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];
