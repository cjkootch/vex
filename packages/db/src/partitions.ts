/**
 * Partition maintenance for `raw_events` and `events`.
 *
 * Neon serverless doesn't ship pg_cron, so a BullMQ job on the worker calls
 * `createNextMonthPartitions()` daily. The helper is idempotent (CREATE TABLE
 * IF NOT EXISTS) and cheap enough to run more often if we ever need to.
 */
import { sql } from "drizzle-orm";

export interface DirectSqlClient {
  execute: (query: { sql: string; params: readonly unknown[] } | ReturnType<typeof sql>) => Promise<unknown>;
}

/**
 * Compute the name and bounds for the partition that owns rows in `month`.
 *
 * `month` is interpreted in UTC — callers pass `new Date(Date.UTC(y, m, 1))`.
 */
export function monthPartitionBounds(month: Date): {
  readonly name: (parent: string) => string;
  readonly from: string;
  readonly to: string;
} {
  const y = month.getUTCFullYear();
  const m = month.getUTCMonth(); // 0-indexed
  const start = new Date(Date.UTC(y, m, 1));
  const end = new Date(Date.UTC(y, m + 1, 1));
  const yy = String(start.getUTCFullYear());
  const mm = String(start.getUTCMonth() + 1).padStart(2, "0");
  return {
    name: (parent) => `${parent}_${yy}_${mm}`,
    from: start.toISOString().slice(0, 10),
    to: end.toISOString().slice(0, 10),
  };
}

/**
 * Return the UTC first-of-month for the month *after* the given date.
 */
export function nextMonth(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
}

/**
 * Idempotently create the next month's partitions for `raw_events` and
 * `events`. Runs on the direct (migration) connection because partition DDL
 * can't be executed through the transaction-mode pooler.
 */
export async function createNextMonthPartitions(
  db: DirectSqlClient,
  now: Date = new Date(),
): Promise<{ created: string[] }> {
  const target = nextMonth(now);
  const bounds = monthPartitionBounds(target);
  const created: string[] = [];

  for (const parent of ["raw_events", "events"] as const) {
    const partition = bounds.name(parent);
    const stmt = sql.raw(
      `CREATE TABLE IF NOT EXISTS ${partition} PARTITION OF ${parent} ` +
        `FOR VALUES FROM ('${bounds.from}') TO ('${bounds.to}')`,
    );
    await db.execute(stmt);
    created.push(partition);
  }

  return { created };
}
