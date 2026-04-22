import { index, jsonb, pgTable, text, timestamp } from "drizzle-orm/pg-core";
import { leadStatusEnum } from "./enums.js";
import { organizations } from "./organizations.js";
import { contacts } from "./contacts.js";
import { users } from "./users.js";
import type { ExternalKeys } from "./organizations.js";

export const leads = pgTable(
  "leads",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id").notNull(),
    orgId: text("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    contactId: text("contact_id").references(() => contacts.id, { onDelete: "set null" }),
    ownerId: text("owner_id").references(() => users.id, { onDelete: "set null" }),
    status: leadStatusEnum("status").notNull().default("new"),
    stage: text("stage"),
    qualificationSummary: text("qualification_summary"),
    externalKeys: jsonb("external_keys").$type<ExternalKeys>().notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    tenantIdx: index("leads_tenant_idx").on(t.tenantId),
    orgIdx: index("leads_org_idx").on(t.orgId),
    contactIdx: index("leads_contact_idx").on(t.contactId),
    statusIdx: index("leads_status_idx").on(t.status),
    // GIN index for external_keys containment — the website-chat
    // normalizer looks up a lead by conversation_id on conversation.ended.
    // See migration 0021.
    externalKeysGinIdx: index("leads_external_keys_gin_idx").using(
      "gin",
      t.externalKeys,
    ),
  }),
);

export type Lead = typeof leads.$inferSelect;
export type NewLead = typeof leads.$inferInsert;
