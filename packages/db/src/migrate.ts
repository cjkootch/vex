// `pg` is CommonJS; Node's strict ESM resolver can't pull named exports off it.
import pg from "pg";
const { Pool } = pg;
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { loadEnv } from "@vex/config";

/**
 * Migration runner. Connects via MIGRATION_DATABASE_URL (the direct Neon
 * endpoint) because pooled connections cannot execute DDL reliably.
 *
 * Runs as neondb_owner — Postgres table owners bypass RLS unless the table
 * is marked FORCE ROW LEVEL SECURITY (we don't). Earlier versions did
 * `SET ROLE vex_migrator` but that role lacks CREATE on the database, so
 * drizzle's migration-tracking schema couldn't be created.
 */
async function main(): Promise<void> {
  const env = loadEnv();
  const pool = new Pool({ connectionString: env.MIGRATION_DATABASE_URL });

  const here = dirname(fileURLToPath(import.meta.url));
  const migrationsFolder = resolve(here, "../drizzle");

  try {
    const client = await pool.connect();
    try {
      const { rows } = await client.query<{
        current_user: string;
        session_user: string;
        current_database: string;
      }>("SELECT current_user, session_user, current_database()");
      const who = rows[0]!;
      // eslint-disable-next-line no-console
      console.log(
        `migrate: connected user=${who.current_user} session=${who.session_user} db=${who.current_database}`,
      );
      const db = drizzle(client);
      await migrate(db, { migrationsFolder });
    } finally {
      client.release();
    }
    // eslint-disable-next-line no-console
    console.log("migrations applied");
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});
