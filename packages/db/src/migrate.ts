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

      // Schema-vs-ledger desync repair. We've observed a state where
      // `drizzle.__drizzle_migrations` claims 0002 + 0003 are applied
      // but the tables they create (e.g. `fuel_deals`,
      // `contact_org_memberships`) don't exist on disk. Drizzle then
      // reports "migrations applied" without running anything and
      // nothing ever catches up.
      //
      // Repair: if the drizzle schema exists AND fuel_deals does not,
      // treat every ledger row past the first two (0000 + 0001) as
      // suspect and delete them. The next drizzle.migrate call will
      // find 0002+ pending and run them for real.
      //
      // Runs as the connection owner (neondb_owner) BEFORE
      // SET ROLE vex_migrator so ownership of the drizzle schema
      // doesn't bite us.
      try {
        await client.query(`
          DO $repair$ BEGIN
            IF EXISTS (SELECT 1 FROM information_schema.schemata WHERE schema_name = 'drizzle')
               AND NOT EXISTS (
                 SELECT 1 FROM information_schema.tables
                 WHERE table_schema = 'public' AND table_name = 'fuel_deals'
               )
            THEN
              DELETE FROM drizzle.__drizzle_migrations
              WHERE id IN (
                SELECT id FROM drizzle.__drizzle_migrations
                ORDER BY id
                OFFSET 2
              );
              RAISE NOTICE 'migrate: drizzle ledger repaired — 0002+ will re-run';
            END IF;
          END $repair$;
        `);
      } catch (err) {
        // eslint-disable-next-line no-console
        console.log(
          `migrate: ledger-repair step skipped (${(err as Error).message})`,
        );
      }

      // Drizzle stores its bookkeeping in a private `drizzle` schema.
      // When that schema already exists (created by a prior run under
      // neondb_owner), vex_migrator needs USAGE / CREATE plus full
      // privileges on its tables to record new migration entries.
      // The block is wrapped in its own catch because the schema may
      // not exist yet on a fresh database — drizzle will create it
      // itself in that case, and vex_migrator will own it.
      try {
        await client.query(`
          DO $drizzle_grants$ BEGIN
            IF EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'drizzle') THEN
              GRANT USAGE, CREATE ON SCHEMA drizzle TO vex_migrator;
              GRANT ALL ON ALL TABLES    IN SCHEMA drizzle TO vex_migrator;
              GRANT ALL ON ALL SEQUENCES IN SCHEMA drizzle TO vex_migrator;
              ALTER DEFAULT PRIVILEGES IN SCHEMA drizzle
                GRANT ALL ON TABLES    TO vex_migrator;
              ALTER DEFAULT PRIVILEGES IN SCHEMA drizzle
                GRANT ALL ON SEQUENCES TO vex_migrator;
            END IF;
          END $drizzle_grants$;
        `);
      } catch (err) {
        // eslint-disable-next-line no-console
        console.log(
          `migrate: drizzle-schema grants skipped (${(err as Error).message})`,
        );
      }

      // Capture the connection role BEFORE SET ROLE so we can grant
      // back to it after migrations. New tables created under
      // vex_migrator are owned by vex_migrator; without an explicit
      // grant the runtime role can't even SELECT them, which is what
      // bit /api/deals + /api/organizations with
      // \"permission denied for table fuel_deals\" /
      // \"permission denied for table contact_org_memberships\".
      const ownerRow = await client.query<{ owner: string }>(
        `SELECT current_user AS owner`,
      );
      const runtimeRole = ownerRow.rows[0]?.owner ?? "neondb_owner";

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

      // Hand the new schema back to the runtime role.
      // SET ROLE is reset, then GRANT and ALTER DEFAULT PRIVILEGES
      // are issued so the API can read every table the migration
      // just created. Idempotent and safe against pre-existing
      // grants.
      try {
        await client.query("RESET ROLE");
        // Grant to the captured runtime role AND to PUBLIC. The PUBLIC
        // grant is the safety net for cases where APPLICATION_DATABASE_URL
        // connects as a different role than MIGRATION_DATABASE_URL —
        // RLS still enforces tenant isolation row-by-row, so granting
        // table-level access broadly is safe.
        await client.query(`
          GRANT ALL ON ALL TABLES    IN SCHEMA public TO ${quoteIdent(runtimeRole)};
          GRANT ALL ON ALL SEQUENCES IN SCHEMA public TO ${quoteIdent(runtimeRole)};
          GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO PUBLIC;
          GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO PUBLIC;
          ALTER DEFAULT PRIVILEGES FOR ROLE vex_migrator IN SCHEMA public
            GRANT ALL ON TABLES    TO ${quoteIdent(runtimeRole)};
          ALTER DEFAULT PRIVILEGES FOR ROLE vex_migrator IN SCHEMA public
            GRANT ALL ON SEQUENCES TO ${quoteIdent(runtimeRole)};
          ALTER DEFAULT PRIVILEGES FOR ROLE vex_migrator IN SCHEMA public
            GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO PUBLIC;
          ALTER DEFAULT PRIVILEGES FOR ROLE vex_migrator IN SCHEMA public
            GRANT USAGE, SELECT ON SEQUENCES TO PUBLIC;
        `);
        // eslint-disable-next-line no-console
        console.log(
          `migrate: granted full table access to ${runtimeRole} + PUBLIC fallback`,
        );
      } catch (err) {
        // eslint-disable-next-line no-console
        console.log(
          `migrate: post-migrate grant to ${runtimeRole} failed (${(err as Error).message})`,
        );
      }
    } finally {
      client.release();
    }
    // eslint-disable-next-line no-console
    console.log("migrations applied");
  } finally {
    await pool.end();
  }
}

function quoteIdent(name: string): string {
  // Postgres double-quote escape: " → "". Safe for identifiers we
  // pulled straight from current_user.
  return `"${name.replace(/"/g, '""')}"`;
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});
