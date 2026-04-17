// `pg` is CommonJS; Node's strict ESM resolver can't pull named exports off it.
import pg from "pg";
const { Pool } = pg;
import { readMigrationFiles } from "drizzle-orm/migrator";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { loadEnv } from "@vex/config";

/**
 * Bootstrap drizzle's migration-tracking state from whatever's already in
 * the database. Earlier workflow failures left the DB with 0000's tables
 * (and maybe 0001's role) applied directly while drizzle's
 * `__drizzle_migrations` table was never created — so `pnpm db:migrate`
 * loops back to 0000 and trips on `type "workspace_plan" already exists`.
 *
 * Creates the tracking schema+table and inserts hashes for the migrations
 * whose DB side-effects we can detect. drizzle's hash algorithm is applied
 * via `readMigrationFiles`, which is what the real migrator uses, so the
 * inserted hashes match drizzle's own expectation.
 *
 * Safe to re-run: every write is idempotent.
 */
async function main(): Promise<void> {
  const env = loadEnv();
  const pool = new Pool({ connectionString: env.MIGRATION_DATABASE_URL });

  const here = dirname(fileURLToPath(import.meta.url));
  const migrationsFolder = resolve(here, "../drizzle");
  const migrations = readMigrationFiles({ migrationsFolder });

  const client = await pool.connect();
  try {
    const { rows: [who] } = await client.query<{
      current_user: string;
      current_database: string;
    }>("SELECT current_user, current_database()");
    // eslint-disable-next-line no-console
    console.log(
      `bootstrap: connected user=${who.current_user} db=${who.current_database}`,
    );

    await client.query('CREATE SCHEMA IF NOT EXISTS "drizzle"');
    await client.query(`
      CREATE TABLE IF NOT EXISTS "drizzle"."__drizzle_migrations" (
        id SERIAL PRIMARY KEY,
        hash text NOT NULL,
        created_at bigint
      )
    `);

    // Detectors: each returns true if the DB shows evidence the migration
    // already ran. Keyed by migration tag so the hash comes from drizzle's
    // own readMigrationFiles output below.
    const detectors: Record<string, () => Promise<boolean>> = {
      "0000_sprint1_canonical": async () => {
        const { rows } = await client.query<{ exists: boolean }>(
          "SELECT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'workspace_plan') AS exists",
        );
        return rows[0]?.exists ?? false;
      },
      "0001_enable_rls": async () => {
        const { rows } = await client.query<{ exists: boolean }>(
          "SELECT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'vex_migrator') AS exists",
        );
        return rows[0]?.exists ?? false;
      },
    };

    const { rows: already } = await client.query<{ hash: string }>(
      'SELECT hash FROM "drizzle"."__drizzle_migrations"',
    );
    const trackedHashes = new Set(already.map((r) => r.hash));

    // readMigrationFiles walks _journal.json in idx order, so migrations[i]
    // lines up with the journal's tag at that idx.
    const journalPath = resolve(migrationsFolder, "meta/_journal.json");
    const { readFileSync } = await import("node:fs");
    const journal = JSON.parse(readFileSync(journalPath, "utf-8")) as {
      entries: { idx: number; tag: string }[];
    };
    const tagByIdx = new Map(journal.entries.map((e) => [e.idx, e.tag]));

    for (let idx = 0; idx < migrations.length; idx++) {
      const m = migrations[idx]!;
      const tag = tagByIdx.get(idx);
      if (!tag) continue;

      if (trackedHashes.has(m.hash)) {
        // eslint-disable-next-line no-console
        console.log(`bootstrap: ${tag} already tracked`);
        continue;
      }

      const detector = detectors[tag];
      if (!detector) {
        // eslint-disable-next-line no-console
        console.log(`bootstrap: ${tag} not yet applied — leaving for migrate`);
        continue;
      }

      const applied = await detector();
      if (!applied) {
        // eslint-disable-next-line no-console
        console.log(`bootstrap: ${tag} not detected in DB — leaving for migrate`);
        continue;
      }

      await client.query(
        'INSERT INTO "drizzle"."__drizzle_migrations" (hash, created_at) VALUES ($1, $2)',
        [m.hash, m.folderMillis],
      );
      // eslint-disable-next-line no-console
      console.log(`bootstrap: ${tag} marked applied`);
    }

    // eslint-disable-next-line no-console
    console.log("bootstrap complete");
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});
