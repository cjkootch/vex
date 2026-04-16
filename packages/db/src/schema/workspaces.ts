import { pgTable, text, jsonb, timestamp } from "drizzle-orm/pg-core";
import { workspacePlanEnum } from "./enums.js";

/**
 * Workspace settings shape. Stored as JSONB so operators can tune per-workspace
 * knobs without schema migrations. `source_priority` drives the field-level
 * conflict resolution in `packages/db/src/merge.ts`.
 */
export interface WorkspaceSettings {
  source_priority: string[];
  enabled_agents: string[];
  daily_cost_limit: number;
  kill_all_agents: boolean;
  /**
   * Marketing integrations (optional). GA4 property id drives the hourly
   * polling job; google_ads_customer_id + login_customer_id drive offline
   * conversion upload. All three are missing on workspaces that don't use
   * the marketing rail, and the polling/conversion activities skip cleanly.
   */
  marketing?: {
    ga4_property_id?: string;
    google_ads_customer_id?: string;
    google_ads_login_customer_id?: string;
  };
}

export const workspaces = pgTable("workspaces", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  plan: workspacePlanEnum("plan").notNull().default("free"),
  settings: jsonb("settings").$type<WorkspaceSettings>().notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export type Workspace = typeof workspaces.$inferSelect;
export type NewWorkspace = typeof workspaces.$inferInsert;
