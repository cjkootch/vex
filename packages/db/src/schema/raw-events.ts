import {
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { rawEventStatusEnum } from "./enums.js";

/**
 * `raw_events` is RANGE-partitioned by `received_at`. Partition creation is
 * handled by `createNextMonthPartitions()` in `packages/db/src/partitions.ts`
 * because Neon serverless does not provide pg_cron.
 *
 * The Drizzle table definition here describes the logical shape. The initial
 * partition `raw_events_2026_04` is created by the 0000 migration SQL.
 */
export const rawEvents = pgTable(
  "raw_events",
  {
    id: text("id").notNull(),
    tenantId: text("tenant_id").notNull(),
    provider: text("provider").notNull(),
    providerEventId: text("provider_event_id").notNull(),
    headers: jsonb("headers").$type<Record<string, unknown>>().notNull().default({}),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),
    receivedAt: timestamp("received_at", { withTimezone: true }).notNull(),
    checksum: text("checksum"),
    status: rawEventStatusEnum("status").notNull().default("pending"),
  },
  (t) => ({
    tenantIdx: index("raw_events_tenant_idx").on(t.tenantId),
    receivedAtIdx: index("raw_events_received_at_idx").on(t.receivedAt),
    providerUniq: uniqueIndex("raw_events_provider_event_uniq").on(
      t.receivedAt,
      t.tenantId,
      t.provider,
      t.providerEventId,
    ),
  }),
);

export type RawEvent = typeof rawEvents.$inferSelect;
export type NewRawEvent = typeof rawEvents.$inferInsert;
