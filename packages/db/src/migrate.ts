import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { loadEnv } from "@vex/config";

/**
 * Migration runner. Connects via MIGRATION_DATABASE_URL (the direct Neon
 * endpoint) because pooled connections cannot execute DDL reliably.
 *
 * Switches to the `vex_migrator` role (BYPASSRLS, created by the Sprint 3
 * migration) before running migrations so RLS policies don't block schema
 * changes on policy-protected tables. The very first run — when the role
 * doesn't exist yet — silently falls back to the connection's default role.
 */
async function main(): Promise<void> {
  const env = loadEnv();
  const pool = new Pool({ connectionString: env.MIGRATION_DATABASE_URL });

  const here = dirname(fileURLToPath(import.meta.url));
  const migrationsFolder = resolve(here, "../drizzle");

  try {
    const client = await pool.connect();
    try {
      try {
        await client.query("SET ROLE vex_migrator");
        // eslint-disable-next-line no-console
        console.log("migrate: running as vex_migrator (BYPASSRLS)");
      } catch {
        // eslint-disable-next-line no-console
        console.log("migrate: vex_migrator role not present yet; using default role");
      }
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
