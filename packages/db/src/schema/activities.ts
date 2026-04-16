import {
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
} from "drizzle-orm/pg-core";

export const activities = pgTable(
  "activities",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id").notNull(),
    type: text("type").notNull(),
    relatedObjectIds: jsonb("related_object_ids")
      .$type<Record<string, string>>()
      .notNull()
      .default({}),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull(),
    result: text("result"),
    transcriptRef: text("transcript_ref"),
    durationSeconds: integer("duration_seconds"),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    tenantIdx: index("activities_tenant_idx").on(t.tenantId),
    occurredAtIdx: index("activities_occurred_at_idx").on(t.occurredAt),
  }),
);

export type Activity = typeof activities.$inferSelect;
export type NewActivity = typeof activities.$inferInsert;
