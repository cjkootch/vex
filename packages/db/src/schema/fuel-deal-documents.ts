import { index, pgTable, text, timestamp } from "drizzle-orm/pg-core";
import { dealDocumentTypeEnum } from "./enums.js";
import { fuelDeals } from "./fuel-deals.js";
import { users } from "./users.js";

/**
 * Supporting documents linked to a deal. `storage_key` points at S3 (or
 * whatever blob store `S3Uploader` is configured for); the row itself does
 * not carry the document contents.
 */
export const fuelDealDocuments = pgTable(
  "fuel_deal_documents",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id").notNull(),
    dealId: text("deal_id")
      .notNull()
      .references(() => fuelDeals.id, { onDelete: "cascade" }),
    documentType: dealDocumentTypeEnum("document_type").notNull(),
    storageKey: text("storage_key").notNull(),
    filename: text("filename").notNull(),
    uploadedBy: text("uploaded_by").references(() => users.id, { onDelete: "set null" }),
    uploadedAt: timestamp("uploaded_at", { withTimezone: true }).notNull().defaultNow(),
    notes: text("notes"),
  },
  (t) => ({
    tenantIdx: index("fuel_deal_documents_tenant_idx").on(t.tenantId),
    dealIdx: index("fuel_deal_documents_deal_idx").on(t.dealId),
    typeIdx: index("fuel_deal_documents_type_idx").on(t.dealId, t.documentType),
  }),
);

export type FuelDealDocument = typeof fuelDealDocuments.$inferSelect;
export type NewFuelDealDocument = typeof fuelDealDocuments.$inferInsert;
