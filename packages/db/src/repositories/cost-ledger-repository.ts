import { and, eq, gte, lt, sum } from "drizzle-orm";
import type { Tx } from "../client.js";
import { costLedger } from "../schema/cost-ledger.js";

export interface CostLedgerRepository {
  /**
   * Sum `cost_usd_micros` for a tenant within a half-open time window
   * `[start, end)`. Returns integer micros; caller converts to USD.
   *
   * Scope: the caller must already be inside `withTenant(db, tenantId, …)`
   * so RLS scopes the read. We additionally filter by tenantId in the
   * WHERE clause so the query uses the `(tenant_id, occurred_at)` index
   * without a sequential scan.
   */
  sumBetween(tx: Tx, tenantId: string, start: Date, end: Date): Promise<number>;
  /**
   * Sum today's cost (UTC day) for a tenant. Convenience for the agent
   * runner's pre-run budget gate.
   */
  sumForTenantToday(tx: Tx, tenantId: string, now?: Date): Promise<number>;
}

export class PostgresCostLedgerRepository implements CostLedgerRepository {
  async sumBetween(
    tx: Tx,
    tenantId: string,
    start: Date,
    end: Date,
  ): Promise<number> {
    const [row] = await tx
      .select({ total: sum(costLedger.costUsdMicros) })
      .from(costLedger)
      .where(
        and(
          eq(costLedger.tenantId, tenantId),
          gte(costLedger.occurredAt, start),
          lt(costLedger.occurredAt, end),
        ),
      );
    // Drizzle returns `sum` as a decimal string or null. Coerce carefully —
    // parseInt of a very large number would truncate, so go via Number and
    // clamp to a safe integer.
    const raw = row?.total ?? null;
    if (raw == null) return 0;
    const n = typeof raw === "number" ? raw : Number(raw);
    return Number.isFinite(n) ? Math.round(n) : 0;
  }

  async sumForTenantToday(
    tx: Tx,
    tenantId: string,
    now: Date = new Date(),
  ): Promise<number> {
    const start = startOfUtcDay(now);
    const end = new Date(start.getTime() + 24 * 60 * 60 * 1000);
    return this.sumBetween(tx, tenantId, start, end);
  }
}

function startOfUtcDay(d: Date): Date {
  return new Date(
    Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 0, 0, 0, 0),
  );
}
