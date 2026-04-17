/**
 * RLS audit — Sprint 13.
 *
 * Verifies that every Vex business table:
 *   (1) has row-level security enabled (pg_class.relrowsecurity),
 *   (2) returns zero rows when queried with a fake tenant id.
 *
 * Run nightly in CI. Exits 1 on any failure so a broken tenant
 * isolation guarantee trips the red build light fast.
 *
 *   MIGRATION_DATABASE_URL=<direct-neon-url> \
 *     pnpm --filter=@vex/db exec tsx ../../scripts/audit-rls.ts
 *
 * Connection notes:
 *   - Uses MIGRATION_DATABASE_URL (direct endpoint). The pooled
 *     endpoint is fine too but pg_bouncer in transaction mode can
 *     reset SET LOCAL state across statements.
 *   - Does NOT `SET ROLE vex_migrator`. That role carries BYPASSRLS
 *     and the cross-tenant test would always pass; we need the
 *     connection's default role (neondb_owner) which honours RLS.
 */
import pg from "pg";
const { Pool } = pg;
import { loadEnv } from "@vex/config";

// Every table enabled in `0001_enable_rls.sql` plus the Sprint 11
// fuel-deal tables from `0002_fuel_deals.sql`. Kept as a literal
// list so adding a table forces a CI review here.
const BUSINESS_TABLES: readonly string[] = [
  "users",
  "organizations",
  "contacts",
  "leads",
  "campaigns",
  "touchpoints",
  "threads",
  "messages",
  "activities",
  "documents",
  "summaries",
  "raw_events",
  "events",
  "embedding_chunks",
  "agent_runs",
  "approvals",
  // Sprint 11 fuel-deal tables.
  "fuel_deals",
  "fuel_deal_cost_stack",
  "fuel_deal_cashflow_events",
  "fuel_deal_scenarios",
  "fuel_deal_counterparty_scores",
  "fuel_deal_documents",
  "fuel_market_rates",
];

const FAKE_TENANT_ID = "audit-rls-fake-tenant-that-should-never-match";

interface TableResult {
  table: string;
  rlsEnabled: boolean;
  rowsForFakeTenant: number | "skipped";
  pass: boolean;
  failure?: string;
}

async function main(): Promise<void> {
  const env = loadEnv();
  if (!env.MIGRATION_DATABASE_URL) {
    console.error("MIGRATION_DATABASE_URL is required");
    process.exit(1);
  }

  const pool = new Pool({ connectionString: env.MIGRATION_DATABASE_URL });
  const client = await pool.connect();
  const results: TableResult[] = [];

  try {
    for (const table of BUSINESS_TABLES) {
      results.push(await auditTable(client, table));
    }
  } finally {
    client.release();
    await pool.end();
  }

  printResults(results);
  const failures = results.filter((r) => !r.pass);
  if (failures.length > 0) {
    console.error(
      `\n${failures.length} of ${results.length} tables failed the RLS audit.`,
    );
    process.exit(1);
  }
  console.log(`\nAll ${results.length} tables passed the RLS audit.`);
}

async function auditTable(
  client: pg.PoolClient,
  table: string,
): Promise<TableResult> {
  // 1. RLS enabled? pg_class.relrowsecurity is authoritative — pg_tables
  //    exposes the same field as `rowsecurity`.
  const { rows: rlsRows } = await client.query<{ rowsecurity: boolean }>(
    `
      SELECT rowsecurity
      FROM pg_tables
      WHERE schemaname = 'public' AND tablename = $1
    `,
    [table],
  );
  if (rlsRows.length === 0) {
    return {
      table,
      rlsEnabled: false,
      rowsForFakeTenant: "skipped",
      pass: false,
      failure: "table does not exist in schema 'public'",
    };
  }
  const rlsEnabled = rlsRows[0]!.rowsecurity;
  if (!rlsEnabled) {
    return {
      table,
      rlsEnabled: false,
      rowsForFakeTenant: "skipped",
      pass: false,
      failure: "ALTER TABLE ... ENABLE ROW LEVEL SECURITY not applied",
    };
  }

  // 2. Cross-tenant isolation — count rows visible under a fake id.
  //    Runs in its own transaction so SET LOCAL disappears on ROLLBACK.
  await client.query("BEGIN");
  let rowsForFakeTenant = 0;
  let failure: string | undefined;
  try {
    await client.query(
      `SELECT set_config('app.tenant_id', $1, true)`,
      [FAKE_TENANT_ID],
    );
    const { rows: countRows } = await client.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM ${quoteIdent(table)}`,
    );
    rowsForFakeTenant = Number.parseInt(countRows[0]?.count ?? "0", 10);
    if (rowsForFakeTenant > 0) {
      failure = `cross-tenant query returned ${rowsForFakeTenant} rows (expected 0)`;
    }
  } catch (err) {
    failure = `query failed: ${(err as Error).message}`;
  } finally {
    await client.query("ROLLBACK");
  }

  return {
    table,
    rlsEnabled: true,
    rowsForFakeTenant,
    pass: failure === undefined,
    ...(failure ? { failure } : {}),
  };
}

function printResults(results: TableResult[]): void {
  console.log(
    "\nRLS AUDIT — every row should read 'pass' with rows=0 for the fake tenant.\n",
  );
  const width = Math.max(...results.map((r) => r.table.length));
  for (const r of results) {
    const marker = r.pass ? "\u2713" : "\u2717";
    const rlsLabel = r.rlsEnabled ? "rls=on " : "rls=off";
    const rowsLabel =
      typeof r.rowsForFakeTenant === "number"
        ? `rows=${String(r.rowsForFakeTenant).padStart(3, " ")}`
        : "rows=n/a";
    const suffix = r.failure ? `  — ${r.failure}` : "";
    console.log(
      `${marker} ${r.table.padEnd(width, " ")}  ${rlsLabel}  ${rowsLabel}${suffix}`,
    );
  }
}

/**
 * Table names in the audit are a hard-coded allow-list, but we still
 * quote-identify them so a future table with reserved-word-ish
 * characters doesn't need a change to the core loop.
 */
function quoteIdent(name: string): string {
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name)) {
    throw new Error(`refusing to audit unsafe table name: ${name}`);
  }
  return `"${name}"`;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
