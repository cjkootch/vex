import {
  doublePrecision,
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
} from "drizzle-orm/pg-core";
import { campaignStatusEnum } from "./enums.js";
import type { ExternalKeys } from "./organizations.js";

export const campaigns = pgTable(
  "campaigns",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id").notNull(),
    channel: text("channel").notNull(),
    source: text("source"),
    medium: text("medium"),
    accountRef: text("account_ref"),
    spend: doublePrecision("spend"),
    objective: text("objective"),
    externalKeys: jsonb("external_keys").$type<ExternalKeys>().notNull().default({}),
    status: campaignStatusEnum("status").notNull().default("active"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    tenantIdx: index("campaigns_tenant_idx").on(t.tenantId),
    statusIdx: index("campaigns_status_idx").on(t.status),
  }),
);

export type Campaign = typeof campaigns.$inferSelect;
export type NewCampaign = typeof campaigns.$inferInsert;
