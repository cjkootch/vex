import {
  check,
  index,
  pgTable,
  text,
  timestamp,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

/**
 * Sprint P — deferred action primitive. Chat commands like
 * "remind me about Acme next Thursday" and "assign this to Jane"
 * both materialise as `follow_ups` rows. The /app/follow-ups UI
 * surfaces upcoming + overdue sorted by due_at.
 */
export const followUps = pgTable(
  "follow_ups",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id").notNull(),
    title: text("title").notNull(),
    note: text("note"),
    dueAt: timestamp("due_at", { withTimezone: true }).notNull(),
    subjectType: text("subject_type"),
    subjectId: text("subject_id"),
    assignedTo: text("assigned_to"),
    createdBy: text("created_by").notNull(),
    status: text("status").notNull().default("open"),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    tenantIdx: index("follow_ups_tenant_idx").on(t.tenantId),
    dueIdx: index("follow_ups_due_idx").on(t.tenantId, t.status, t.dueAt),
    subjectIdx: index("follow_ups_subject_idx").on(
      t.tenantId,
      t.subjectType,
      t.subjectId,
    ),
    statusCheck: check(
      "follow_ups_status_check",
      sql`${t.status} IN ('open', 'completed', 'cancelled')`,
    ),
  }),
);

export type FollowUp = typeof followUps.$inferSelect;
export type NewFollowUp = typeof followUps.$inferInsert;
