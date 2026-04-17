import { pgTable, text, jsonb, timestamp } from "drizzle-orm/pg-core";
import { workspacePlanEnum } from "./enums.js";

/**
 * Workspace settings shape. Stored as JSONB so operators can tune per-workspace
 * knobs without schema migrations. `source_priority` drives the field-level
 * conflict resolution in `packages/db/src/merge.ts`.
 *
 * Sprint 13 adds:
 *   - `feature_rollout`: map of feature name → rollout % (0-100). Consumed
 *     by `isFeatureEnabled(featureName, tenantId, pct)` from @vex/config.
 *   - `sharing_enabled`: gate for the deferred OpenFGA binding (see
 *     docs/adr/006). Default false; flipping it engages the real client
 *     once it ships.
 */
export interface WorkspaceSettings {
  source_priority: string[];
  enabled_agents: string[];
  daily_cost_limit: number;
  kill_all_agents: boolean;
  /** Optional — absent on pre-Sprint-13 rows. Treat undefined as `{}`. */
  feature_rollout?: Record<string, number>;
  /** Optional — absent on pre-Sprint-13 rows. Treat undefined as `false`. */
  sharing_enabled?: boolean;
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
