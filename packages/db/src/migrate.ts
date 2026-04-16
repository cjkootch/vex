import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { loadEnv } from "@vex/config";

/**
 * Migration runner. Connects via MIGRATION_DATABASE_URL (the direct Neon
 * endpoint) because pooled connections cannot execute DDL reliably.
 */
async function main(): Promise<void> {
  const env = loadEnv();
  const pool = new Pool({ connectionString: env.MIGRATION_DATABASE_URL });
  const db = drizzle(pool);

  const here = dirname(fileURLToPath(import.meta.url));
  const migrationsFolder = resolve(here, "../drizzle");

  try {
    await migrate(db, { migrationsFolder });
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
