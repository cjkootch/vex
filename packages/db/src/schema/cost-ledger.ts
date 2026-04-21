import { bigint, index, pgTable, text, timestamp } from "drizzle-orm/pg-core";

/**
 * Append-only ledger of every chargeable operation. Mirrors the
 * CostEntry type in @vex/telemetry.
 *
 * Stored here (not @vex/telemetry) so the Drizzle migrator picks it
 * up. The CostLedger interface stays adapter-ignorant in telemetry;
 * the concrete Postgres implementation in cost-ledger-repository.ts
 * binds the two.
 *
 * `idempotency_key` is unique so retries (and at-least-once queue
 * semantics) don't double-charge.
 *
 * Using `text` for ids instead of uuid to match the ULID convention
 * the rest of the system uses for tenant / agent-run references.
 */
export const costLedger = pgTable(
  "cost_ledger",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id").notNull(),
    agentRunId: text("agent_run_id"),
    idempotencyKey: text("idempotency_key").notNull().unique(),
    operation: text("operation").notNull(),
    provider: text("provider").notNull(),
    model: text("model"),
    units: bigint("units", { mode: "number" }).notNull(),
    unitKind: text("unit_kind").notNull(),
    costUsdMicros: bigint("cost_usd_micros", { mode: "number" }).notNull(),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    tenantOccurredAtIdx: index("cost_ledger_tenant_occurred_at_idx").on(
      t.tenantId,
      t.occurredAt,
    ),
  }),
);

export type CostLedgerRow = typeof costLedger.$inferSelect;
export type NewCostLedgerRow = typeof costLedger.$inferInsert;
