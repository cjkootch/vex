import { index, jsonb, pgTable, text, timestamp } from "drizzle-orm/pg-core";
import { campaigns } from "./campaigns.js";
import { leads } from "./leads.js";
import { contacts } from "./contacts.js";
import { organizations } from "./organizations.js";

export const touchpoints = pgTable(
  "touchpoints",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id").notNull(),
    channel: text("channel").notNull(),
    actor: text("actor"),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull(),
    campaignId: text("campaign_id").references(() => campaigns.id, {
      onDelete: "set null",
    }),
    leadId: text("lead_id").references(() => leads.id, { onDelete: "set null" }),
    contactId: text("contact_id").references(() => contacts.id, {
      onDelete: "set null",
    }),
    orgId: text("org_id").references(() => organizations.id, { onDelete: "set null" }),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    tenantIdx: index("touchpoints_tenant_idx").on(t.tenantId),
    occurredAtIdx: index("touchpoints_occurred_at_idx").on(t.occurredAt),
    campaignIdx: index("touchpoints_campaign_idx").on(t.campaignId),
    leadIdx: index("touchpoints_lead_idx").on(t.leadId),
    contactIdx: index("touchpoints_contact_idx").on(t.contactId),
    orgIdx: index("touchpoints_org_idx").on(t.orgId),
  }),
);

export type Touchpoint = typeof touchpoints.$inferSelect;
export type NewTouchpoint = typeof touchpoints.$inferInsert;
