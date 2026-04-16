import { index, jsonb, pgTable, text, timestamp } from "drizzle-orm/pg-core";
import { messageDirectionEnum } from "./enums.js";
import { threads } from "./threads.js";

export const messages = pgTable(
  "messages",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id").notNull(),
    threadId: text("thread_id")
      .notNull()
      .references(() => threads.id, { onDelete: "cascade" }),
    direction: messageDirectionEnum("direction").notNull(),
    contentRef: text("content_ref"),
    sentiment: text("sentiment"),
    outcome: text("outcome"),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    tenantIdx: index("messages_tenant_idx").on(t.tenantId),
    threadIdx: index("messages_thread_idx").on(t.threadId),
  }),
);

export type Message = typeof messages.$inferSelect;
export type NewMessage = typeof messages.$inferInsert;
