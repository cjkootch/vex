import {
  boolean,
  index,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { contacts } from "./contacts.js";
import { organizations } from "./organizations.js";

/**
 * Many-to-many link between contacts and organizations. A contact may
 * represent more than one company (traders, fractional execs,
 * consortium reps) — exactly one membership per contact is flagged
 * `is_primary = true` via a partial unique index enforced at the DB
 * layer.
 *
 * `contacts.org_id` is retained as the denormalised primary pointer
 * so existing readers keep working while the broader codebase is
 * migrated to read through this table.
 */
export const contactOrgMemberships = pgTable(
  "contact_org_memberships",
  {
    tenantId: text("tenant_id").notNull(),
    contactId: text("contact_id")
      .notNull()
      .references(() => contacts.id, { onDelete: "cascade" }),
    orgId: text("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    role: text("role"),
    isPrimary: boolean("is_primary").notNull().default(false),
    since: timestamp("since", { withTimezone: true }).notNull().defaultNow(),
    until: timestamp("until", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.contactId, t.orgId] }),
    tenantIdx: index("contact_org_memberships_tenant_idx").on(t.tenantId),
    orgIdx: index("contact_org_memberships_org_idx").on(t.orgId),
    contactIdx: index("contact_org_memberships_contact_idx").on(t.contactId),
    // Partial unique index — one primary per contact.
    onePrimaryPerContact: uniqueIndex("contact_org_memberships_one_primary_per_contact")
      .on(t.contactId)
      .where(sql`${t.isPrimary}`),
  }),
);

export type ContactOrgMembership = typeof contactOrgMemberships.$inferSelect;
export type NewContactOrgMembership = typeof contactOrgMemberships.$inferInsert;
