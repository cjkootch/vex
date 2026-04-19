import {
  doublePrecision,
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
} from "drizzle-orm/pg-core";
import { recordStatusEnum } from "./enums.js";
import { organizations } from "./organizations.js";
import type { ExternalKeys, FieldConfidenceMap } from "./organizations.js";

export const contacts = pgTable(
  "contacts",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id").notNull(),
    /**
     * @deprecated Legacy denormalized pointer to the contact's primary
     * org. Sprint 14 introduced `contact_org_memberships` as the
     * real m:n model; every writer keeps this column in sync with the
     * primary membership for backwards-compat, but new readers should
     * prefer \`ContactRepository.getPrimaryOrgId()\` (or the
     * memberships table directly) so we can drop the column once the
     * remaining legacy readers (calls, resend normalizer, retrieval)
     * migrate.
     */
    orgId: text("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    fullName: text("full_name").notNull(),
    title: text("title"),
    emails: jsonb("emails").$type<string[]>().notNull().default([]),
    phones: jsonb("phones").$type<string[]>().notNull().default([]),
    roleScore: doublePrecision("role_score"),
    externalKeys: jsonb("external_keys").$type<ExternalKeys>().notNull().default({}),
    fieldConfidence: jsonb("field_confidence")
      .$type<FieldConfidenceMap>()
      .notNull()
      .default({}),
    /** Sprint O — free-form tags appended by the chat agent. */
    tags: jsonb("tags").$type<string[]>().notNull().default([]),
    status: recordStatusEnum("status").notNull().default("active"),
    timezone: text("timezone"),
    optOutAt: timestamp("opt_out_at", { withTimezone: true }),
    optOutReason: text("opt_out_reason"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    tenantIdx: index("contacts_tenant_idx").on(t.tenantId),
    orgIdx: index("contacts_org_idx").on(t.orgId),
    statusIdx: index("contacts_status_idx").on(t.status),
  }),
);

export type Contact = typeof contacts.$inferSelect;
export type NewContact = typeof contacts.$inferInsert;
