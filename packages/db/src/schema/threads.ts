import { index, jsonb, pgTable, text, timestamp } from "drizzle-orm/pg-core";

export const threads = pgTable(
  "threads",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id").notNull(),
    channel: text("channel").notNull(),
    subject: text("subject"),
    participantIds: jsonb("participant_ids").$type<string[]>().notNull().default([]),
    lastMessageAt: timestamp("last_message_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    tenantIdx: index("threads_tenant_idx").on(t.tenantId),
  }),
);

export type Thread = typeof threads.$inferSelect;
export type NewThread = typeof threads.$inferInsert;
