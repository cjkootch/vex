import { index, integer, pgTable, text, timestamp } from "drizzle-orm/pg-core";
import { organizations } from "./organizations.js";

/**
 * Polymorphic document store. Every row references exactly one
 * subject via (subject_type, subject_id) and points at an S3 object
 * via storage_key. Text-based uploads (PDFs, .txt, .md) are parsed
 * at upload time into `extracted_text` so retrieval can surface
 * snippets to the chat agent without an S3 round-trip.
 */
export const documents = pgTable(
  "documents",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id").notNull(),
    /** Legacy — pre-0009 this was the only link. New rows should
     *  set subjectType="organization" + subjectId instead; orgId
     *  stays populated for backwards-compat. */
    orgId: text("org_id").references(() => organizations.id, {
      onDelete: "set null",
    }),
    subjectType: text("subject_type"),
    subjectId: text("subject_id"),
    title: text("title").notNull(),
    filename: text("filename").notNull().default(""),
    mimeType: text("mime_type").notNull(),
    sizeBytes: integer("size_bytes").notNull().default(0),
    documentType: text("document_type").notNull().default("other"),
    storageKey: text("storage_key").notNull(),
    extractedText: text("extracted_text"),
    extractedTextRef: text("extracted_text_ref"),
    uploadedBy: text("uploaded_by"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    tenantIdx: index("documents_tenant_idx").on(t.tenantId),
    orgIdx: index("documents_org_idx").on(t.orgId),
    subjectIdx: index("documents_subject_idx").on(
      t.tenantId,
      t.subjectType,
      t.subjectId,
    ),
    typeIdx: index("documents_type_idx").on(t.tenantId, t.documentType),
  }),
);

export type Document = typeof documents.$inferSelect;
export type NewDocument = typeof documents.$inferInsert;
