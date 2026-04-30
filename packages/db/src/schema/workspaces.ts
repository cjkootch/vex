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
  /**
   * Operator-configured outbound email signature. When absent, the send
   * path generates a sensible default from workspace + owner context.
   * HTML is appended to the rich-text part of the email; text is
   * appended to the plain-text part. Both are optional; either (or both)
   * can be user-customised without touching the other.
   */
  email_signature?: {
    html?: string;
    text?: string;
    /** ISO-8601 timestamp of the last save. */
    updated_at?: string;
    /** User id of the last saver, or null for seed / default-populated values. */
    updated_by?: string | null;
  };
  /**
   * Display name appended to every outbound email's `From` header.
   * The verified Resend address itself doesn't change — we keep it on
   * the workspace's verified domain for deliverability — but the
   * recipient sees the friendly name. Format: Resend formats the
   * eventual header as `"Display Name" <verified@domain>`. Empty /
   * missing → fall back to the verified address alone.
   */
  email_from_name?: string;
  /**
   * Always-CC addresses on every outbound `email.send`. Operator-set;
   * typical use is "CC my own work address so threads land in my
   * inbox." Recipients see these addresses on the message.
   */
  email_cc?: string[];
}

/**
 * Sprint S — operator-authored "company strategy" block. Prepended to the
 * chat system prompt on every query so Vex reasons inside the tenant's
 * framing: who they sell to, how they talk, what they won't touch, what
 * they're trying to win this quarter.
 *
 * All fields are optional; unset fields simply omit that line from the
 * rendered preamble. A freshly-seeded workspace with `strategy = {}`
 * produces an empty preamble and behaves as if the feature were off.
 *
 * Arrays are free-form strings — no enums, because the right vocabulary
 * is business-specific and operators need flexibility to write in their
 * own voice.
 */
export interface WorkspaceStrategy {
  mission?: string | undefined;
  target_markets?: string[] | undefined;
  icp_buyers?: string | undefined;
  icp_suppliers?: string | undefined;
  brand_voice?: string | undefined;
  pricing_philosophy?: string | undefined;
  no_go_zones?: string[] | undefined;
  growth_priorities?: string[] | undefined;
  additional_guidance?: string | undefined;
  /** ISO-8601 timestamp of the last save. Set by the writer. */
  updated_at?: string | undefined;
  /** User id of the last saver. Null for seed / migration-populated rows. */
  updated_by?: string | null | undefined;
}

export const workspaces = pgTable("workspaces", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  plan: workspacePlanEnum("plan").notNull().default("free"),
  settings: jsonb("settings").$type<WorkspaceSettings>().notNull(),
  strategy: jsonb("strategy").$type<WorkspaceStrategy>().notNull().default({}),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export type Workspace = typeof workspaces.$inferSelect;
export type NewWorkspace = typeof workspaces.$inferInsert;
