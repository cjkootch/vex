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
  /**
   * Which sanctions lists the OFAC screening agent runs against.
   * Each entry is an adapter id; the agent fans out to all listed
   * adapters in parallel and merges the results, stamping each
   * match row with its source list so reviewers triage them
   * differently.
   *
   *   - `us_csl`  — US Trade.gov Consolidated Screening List (~13 US
   *                 lists rolled up: OFAC SDN/NS-PLC/SSI/FSE, BIS
   *                 DPL/EL/UVL/MEU, State DTC/ISN/CAP).
   *   - `eu`     — European Council Consolidated Financial
   *                 Sanctions list.
   *   - `uk_ofsi` — UK Office of Financial Sanctions Implementation
   *                 consolidated list.
   *
   * Default when unset / empty: `["us_csl"]`. EU/UK operators add
   * theirs explicitly. Workspaces with regulatory data-residency
   * concerns can set EU-only by passing `["eu"]`. The legacy
   * `SCREENING_SOURCE` env var still gates whether the US adapter
   * uses CSL or OFAC SDN — this setting controls the broader
   * source set, not the US adapter choice itself.
   */
  enabled_sanctions_lists?: ("us_csl" | "eu" | "uk_ofsi")[];
  /**
   * WhatsApp Business Message Templates registered with Twilio for cold
   * outreach. WhatsApp's 24h customer-care window blocks freeform
   * outbound to recipients who haven't messaged us first; templates are
   * the only way to start a conversation. Each entry is a Meta-approved
   * template registered in Twilio Console (Content Template Builder).
   *
   * The chat agent reads this list from a system-prompt preamble — when
   * an operator says "send Acme the welcome template" Vex picks the
   * template by `name`, resolves the variables from evidence, and emits
   * a `whatsapp.send_template` action.
   *
   * Empty / missing → cold WhatsApp outreach is unavailable; freeform
   * sends still work inside the 24h window.
   */
  whatsapp_templates?: WhatsAppTemplate[];
  /**
   * Operator-authored email templates (Vex-side, distinct from
   * WhatsApp Content Templates which live at Twilio). Used to keep
   * outbound emails consistent across operators and over time.
   * Variables are NAMED placeholders (`{{recipient_name}}`,
   * `{{deal_ref}}`) — the chat agent resolves them from the evidence
   * pack at send time. Untemplated freeform `email.send` continues
   * to work; templates are an opt-in library, not a default.
   */
  email_templates?: EmailTemplate[];
  /**
   * Operator-authored SMS templates. Same shape as email but body-only
   * (no subject) and shorter cap. Bodies should fit ≤320 chars
   * (2 SMS segments) so a templated send doesn't accidentally cost 5x
   * because of variable expansion.
   */
  sms_templates?: SmsTemplate[];
  /**
   * Operator-authored AI-call templates. Body is the `aiInstructions`
   * system prompt the OpenAI Realtime bridge runs against. Used when
   * the operator says "have vex call X with the {name} script". Same
   * variable-resolution rules as email / SMS templates.
   */
  call_templates?: CallTemplate[];
}

export interface WhatsAppTemplate {
  /**
   * Operator-friendly name used in chat ("send Acme the welcome
   * template"). Lowercase, snake_case. Must be unique within the
   * workspace.
   */
  name: string;
  /**
   * Twilio Content Template SID — `HX` followed by 32 hex chars.
   * Generated by Twilio when the template lands in the Content
   * Template Builder; same SID across environments.
   */
  contentSid: string;
  /**
   * Human-readable description of what the template says, surfaced in
   * the system prompt so the model can decide which template fits the
   * operator's intent. Should include a paraphrase of the rendered
   * body so a model that's never seen the template can pick it.
   */
  description?: string | undefined;
  /**
   * Ordered list of variable names that map to Twilio's `{{1}}`,
   * `{{2}}` placeholders. Operator declares these so the agent can
   * resolve them by name from evidence (e.g. `["recipient_name",
   * "deal_ref"]` becomes `{"1": evidence.contact.firstName, "2":
   * evidence.deal.dealRef}`).
   */
  variables?: string[] | undefined;
}

/**
 * Vex-native email template. Variables in `subject` and `body` use
 * named placeholders (`{{recipient_name}}`, `{{deal_ref}}`), resolved
 * at send time by the chat agent from the evidence pack. The
 * declared `variables[]` is a hint to the agent + a render-time
 * sanity check (warn / refuse if a placeholder isn't declared).
 */
export interface EmailTemplate {
  /** Lowercase + snake_case slug. Unique within the workspace. */
  name: string;
  subject: string;
  body: string;
  description?: string | undefined;
  variables?: string[] | undefined;
}

/**
 * Vex-native SMS template. Body-only (no subject). Should be kept
 * ≤320 chars including any worst-case variable expansion to stay
 * within 2 Twilio segments per send.
 */
export interface SmsTemplate {
  name: string;
  body: string;
  description?: string | undefined;
  variables?: string[] | undefined;
}

/**
 * Vex-native AI-call template. `aiInstructions` is the system prompt
 * the OpenAI Realtime bridge runs against during the call.
 * `goal_hint` is a one-line summary of what the call is trying to
 * accomplish; surfaced to the operator on the chip preview so they
 * know what they're approving without reading the full prompt.
 */
export interface CallTemplate {
  name: string;
  aiInstructions: string;
  goal_hint?: string | undefined;
  description?: string | undefined;
  variables?: string[] | undefined;
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
