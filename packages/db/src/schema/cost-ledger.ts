import { pgTable, uuid, text, bigint, timestamp, index } from "drizzle-orm/pg-core";
import { tenants } from "./tenants.js";

/**
 * Append-only Postgres-backed CostLedger. Mirrors the CostEntry type in
 * @vex/telemetry. `idempotency_key` is unique so retries don't double-charge.
 */
export const costLedger = pgTable(
  "cost_ledger",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    agentRunId: uuid("agent_run_id"),
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
