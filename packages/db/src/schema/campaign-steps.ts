import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { campaigns } from "./campaigns.js";

/**
 * Ordered step sequence for a campaign plan. One row per step; the
 * (tenant_id, campaign_id, position) index keeps positions dense
 * within a campaign — Temporal's CampaignEnrollmentWorkflow (Sprint D)
 * advances recipients through steps by position.
 *
 * `gate_condition_json` is a narrow, JSON-shaped DSL the workflow
 * evaluates before dispatching — keep it parseable without ML.
 * Example: `{"all": [{"intent": "interested"}, {"opened_in_last_days": 3}]}`.
 *
 * `auto_approve` shortcuts the ApprovalGate: when true, the dispatch
 * fires without a reviewer click (trusted sequences, internal tests).
 * Defaults to false so the "decide → ask → execute" invariant is the
 * default posture.
 */
export const campaignSteps = pgTable(
  "campaign_steps",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id").notNull(),
    campaignId: text("campaign_id")
      .notNull()
      .references(() => campaigns.id, { onDelete: "cascade" }),
    position: integer("position").notNull(),
    channel: text("channel").notNull(),
    delayAfterPriorMs: integer("delay_after_prior_ms").notNull().default(0),
    /**
     * Name of a template registered in WorkspaceSettings — picks the
     * registry by channel: email_templates / sms_templates /
     * call_templates / whatsapp_templates. The dispatcher resolves
     * the named template at run time and renders {{variables}} from
     * the recipient's contact + linked org. null when the step ships
     * inline content via `subjectOverride` / `bodyOverride` instead,
     * and unconditionally null for `manual` steps.
     */
    templateRef: text("template_ref"),
    /**
     * Inline content overrides for UNTEMPLATED workflow steps. When
     * `templateRef` is null, the dispatcher writes these straight onto
     * the approval payload after rendering {{variables}} against the
     * recipient context. Email steps must set BOTH (subject + body);
     * sms / whatsapp.send / outbound_call only use bodyOverride.
     * `manual` steps leave both null. Both null on a non-manual step
     * with no templateRef = misconfiguration; dispatch fails loud.
     */
    subjectOverride: text("subject_override"),
    bodyOverride: text("body_override"),
    /** Narrow DSL the enrollment workflow evaluates; `{}` = always true. */
    gateConditionJson: jsonb("gate_condition_json")
      .$type<Record<string, unknown>>()
      .notNull()
      .default({}),
    /** ApprovalTier for the dispatch. Valid values: T0 / T1 / T2 / T3. */
    tier: text("tier").notNull().default("T2"),
    autoApprove: boolean("auto_approve").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    tenantIdx: index("campaign_steps_tenant_idx").on(t.tenantId),
    campaignIdx: index("campaign_steps_campaign_idx").on(t.campaignId),
    uniqPosition: uniqueIndex("campaign_steps_position_uniq").on(
      t.tenantId,
      t.campaignId,
      t.position,
    ),
  }),
);

export type CampaignStep = typeof campaignSteps.$inferSelect;
export type NewCampaignStep = typeof campaignSteps.$inferInsert;
