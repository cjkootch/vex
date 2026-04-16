import { index, pgTable, text, timestamp } from "drizzle-orm/pg-core";
import { organizations } from "./organizations.js";

export const documents = pgTable(
  "documents",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id").notNull(),
    orgId: text("org_id").references(() => organizations.id, { onDelete: "set null" }),
    title: text("title").notNull(),
    mimeType: text("mime_type").notNull(),
    storageKey: text("storage_key").notNull(),
    extractedTextRef: text("extracted_text_ref"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    tenantIdx: index("documents_tenant_idx").on(t.tenantId),
    orgIdx: index("documents_org_idx").on(t.orgId),
  }),
);

export type Document = typeof documents.$inferSelect;
export type NewDocument = typeof documents.$inferInsert;
