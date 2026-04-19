import {
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
} from "drizzle-orm/pg-core";

/**
 * Proactive signal layer. Cron-run rules insert rows here to surface
 * conditions operators need to see without asking — laycan
 * approaching without BIS, margin threshold crossed, stale deal,
 * overdue follow-up, etc. Rows stay around after acknowledgement so
 * the audit trail is preserved; the UI filters to unacknowledged.
 */
export const signals = pgTable(
  "signals",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id").notNull(),
    /** Machine id for the rule that fired (stable across restarts). */
    ruleId: text("rule_id").notNull(),
    severity: text("severity").notNull().default("warn"),
    subjectType: text("subject_type"),
    subjectId: text("subject_id"),
    title: text("title").notNull(),
    body: text("body"),
    metadata: jsonb("metadata")
      .$type<Record<string, unknown>>()
      .notNull()
      .default({}),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    acknowledgedAt: timestamp("acknowledged_at", { withTimezone: true }),
    acknowledgedBy: text("acknowledged_by"),
  },
  (t) => ({
    tenantIdx: index("signals_tenant_idx").on(t.tenantId, t.createdAt),
    ruleIdx: index("signals_rule_idx").on(t.tenantId, t.ruleId),
  }),
);

export type Signal = typeof signals.$inferSelect;
export type NewSignal = typeof signals.$inferInsert;
