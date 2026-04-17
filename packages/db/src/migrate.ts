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
      // Ensure `vex_migrator` has the privileges drizzle-migrator needs.
      // Runs as the connection user (neondb_owner on Neon); idempotent.
      // Without CREATE on the database, drizzle's `CREATE SCHEMA IF NOT
      // EXISTS "drizzle"` fails before the migration runs even when the
      // schema already exists. Database name is resolved via
      // current_database() so this script stays portable across Neon
      // projects / branches.
      try {
        await client.query(`
          DO $grants$ BEGIN
            EXECUTE format(
              'GRANT CREATE, TEMPORARY, CONNECT ON DATABASE %I TO vex_migrator',
              current_database()
            );
          END $grants$;
          GRANT USAGE, CREATE ON SCHEMA public TO vex_migrator;
          GRANT ALL ON ALL TABLES    IN SCHEMA public TO vex_migrator;
          GRANT ALL ON ALL SEQUENCES IN SCHEMA public TO vex_migrator;
          ALTER DEFAULT PRIVILEGES IN SCHEMA public
            GRANT ALL ON TABLES    TO vex_migrator;
          ALTER DEFAULT PRIVILEGES IN SCHEMA public
            GRANT ALL ON SEQUENCES TO vex_migrator;
        `);
        // eslint-disable-next-line no-console
        console.log("migrate: vex_migrator privileges ensured");
      } catch (err) {
        // Role doesn't exist on the very first run (before 0001 has
        // been applied). Let SET ROLE fall through to the default
        // branch below.
        // eslint-disable-next-line no-console
        console.log(
          `migrate: could not pre-grant vex_migrator privileges (${(err as Error).message}); continuing`,
        );
      }

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
