import {
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";

/**
 * `events` is RANGE-partitioned by `occurred_at`. Partition creation is handled
 * by `createNextMonthPartitions()` in `packages/db/src/partitions.ts` because
 * Neon serverless does not provide pg_cron.
 *
 * The Drizzle table definition here describes the logical shape. The initial
 * partition `events_2026_04` is created by the 0000 migration SQL.
 */
export const events = pgTable(
  "events",
  {
    id: text("id").notNull(),
    tenantId: text("tenant_id").notNull(),
    verb: text("verb").notNull(),
    subjectType: text("subject_type").notNull(),
    subjectId: text("subject_id").notNull(),
    actorType: text("actor_type"),
    actorId: text("actor_id"),
    objectType: text("object_type"),
    objectId: text("object_id"),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default({}),
  },
  (t) => ({
    tenantIdx: index("events_tenant_idx").on(t.tenantId),
    occurredAtIdx: index("events_occurred_at_idx").on(t.occurredAt),
    idempotencyUniq: uniqueIndex("events_idempotency_uniq").on(
      t.occurredAt,
      t.tenantId,
      t.idempotencyKey,
    ),
  }),
);

export type Event = typeof events.$inferSelect;
export type NewEvent = typeof events.$inferInsert;
