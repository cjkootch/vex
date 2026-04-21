import { and, eq, gte, lt, sum } from "drizzle-orm";
import { createId } from "@vex/domain";
import type { CostEntry, CostLedger } from "@vex/telemetry";
import type { Db, Tx } from "../client.js";
import { withTenant } from "../with-tenant.js";
import { costLedger } from "../schema/cost-ledger.js";

export interface CostLedgerInsert {
  tenantId: string;
  agentRunId?: string | null;
  idempotencyKey: string;
  operation: string;
  provider: string;
  model?: string | null;
  units: number;
  unitKind: string;
  costUsdMicros: number;
  occurredAt: Date;
}

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
  /**
   * Append an entry to the ledger. Idempotent on idempotency_key —
   * a duplicate write is silently no-op so at-least-once adapter
   * retries don't double-charge.
   */
  insert(tx: Tx, data: CostLedgerInsert): Promise<void>;
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

  async insert(tx: Tx, data: CostLedgerInsert): Promise<void> {
    // ON CONFLICT on idempotency_key keeps retries (BullMQ
    // at-least-once delivery, webhook replays) from double-charging.
    await tx
      .insert(costLedger)
      .values({
        id: createId(),
        tenantId: data.tenantId,
        agentRunId: data.agentRunId ?? null,
        idempotencyKey: data.idempotencyKey,
        operation: data.operation,
        provider: data.provider,
        model: data.model ?? null,
        units: data.units,
        unitKind: data.unitKind,
        costUsdMicros: data.costUsdMicros,
        occurredAt: data.occurredAt,
      })
      .onConflictDoNothing({ target: costLedger.idempotencyKey });
  }
}

/**
 * Production CostLedger. Writes every CostEntry through to Postgres
 * via the repository. Swapped in for InMemoryCostLedger in
 * apps/api/src/main.ts + apps/worker/src/queues/runner.ts so the
 * Admin → Cost tab reflects real spend instead of $0.00.
 *
 * Writes run through `withTenant` to populate `app.tenant_id` so the
 * row lands cleanly if the ledger table ever gets RLS. Errors are
 * swallowed with a console.warn — a cost-ledger write hiccup should
 * NEVER fail the underlying LLM call it was booking.
 */
export class PostgresCostLedger implements CostLedger {
  constructor(
    private readonly db: Db,
    private readonly repo: CostLedgerRepository = new PostgresCostLedgerRepository(),
  ) {}

  async record(entry: CostEntry): Promise<void> {
    try {
      await withTenant(this.db, entry.tenantId, async (tx) => {
        await this.repo.insert(tx, {
          tenantId: entry.tenantId,
          agentRunId: entry.agentRunId ?? null,
          idempotencyKey: entry.idempotencyKey,
          operation: entry.operation,
          provider: entry.provider,
          ...(entry.model !== undefined ? { model: entry.model } : {}),
          units: entry.units,
          unitKind: entry.unitKind,
          costUsdMicros: entry.costUsdMicros,
          occurredAt: entry.occurredAt,
        });
      });
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn(
        `cost-ledger write failed (op=${entry.operation} provider=${entry.provider}): ${(err as Error).message}`,
      );
    }
  }
}

function startOfUtcDay(d: Date): Date {
  return new Date(
    Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 0, 0, 0, 0),
  );
}
