import { index, pgTable, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { organizations } from "./organizations.js";

/**
 * Sprint W — which products an org can source / broker / buy. One
 * row per (org, product). A broker whose upstream suppliers are
 * unknown just gets product rows on itself with no corresponding
 * `organization_relationships` edge.
 *
 * `product` mirrors the product_type enum values but is stored as
 * text so brokers can tag products we haven't catalogued formally.
 * The app layer validates against the enum on insert.
 */
export const organizationProducts = pgTable(
  "organization_products",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id").notNull(),
    orgId: text("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    product: text("product").notNull(),
    notes: text("notes"),
    addedBy: text("added_by"),
    addedAt: timestamp("added_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    orgProductUq: uniqueIndex("organization_products_org_product_uq").on(
      t.tenantId,
      t.orgId,
      t.product,
    ),
    productIdx: index("organization_products_product_idx").on(
      t.tenantId,
      t.product,
    ),
  }),
);

export type OrganizationProduct = typeof organizationProducts.$inferSelect;
export type NewOrganizationProduct = typeof organizationProducts.$inferInsert;
