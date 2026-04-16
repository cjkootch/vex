import {
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";

export const summaries = pgTable(
  "summaries",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id").notNull(),
    subjectType: text("subject_type").notNull(),
    subjectId: text("subject_id").notNull(),
    summaryType: text("summary_type").notNull(),
    version: integer("version").notNull().default(1),
    content: text("content").notNull(),
    validityWindowStart: timestamp("validity_window_start", { withTimezone: true }),
    validityWindowEnd: timestamp("validity_window_end", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    tenantIdx: index("summaries_tenant_idx").on(t.tenantId),
    subjectIdx: index("summaries_subject_idx").on(t.tenantId, t.subjectType, t.subjectId),
    uniqPerVersion: uniqueIndex("summaries_unique_per_version").on(
      t.tenantId,
      t.subjectType,
      t.subjectId,
      t.summaryType,
      t.version,
    ),
  }),
);

export type Summary = typeof summaries.$inferSelect;
export type NewSummary = typeof summaries.$inferInsert;
