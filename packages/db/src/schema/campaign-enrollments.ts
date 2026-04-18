import {
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { campaigns } from "./campaigns.js";
import { contacts } from "./contacts.js";

/**
 * One row per contact enrolled in a campaign plan. The Temporal
 * CampaignEnrollmentWorkflow (Sprint D) owns step advancement —
 * `current_step` is the zero-indexed position the workflow is about
 * to run next; `state` drives branching.
 *
 * `branch_history_json` is an append-only audit of every gate
 * evaluation + dispatch outcome, ordered by step. Kept as JSONB so
 * the Sprint D intent classifier can read branch decisions without a
 * schema migration per new intent type.
 *
 * Unique (tenant_id, campaign_id, contact_id) — a contact can only
 * be enrolled once per campaign; re-enrolling requires completing or
 * unsubscribing first.
 */
export const campaignEnrollments = pgTable(
  "campaign_enrollments",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id").notNull(),
    campaignId: text("campaign_id")
      .notNull()
      .references(() => campaigns.id, { onDelete: "cascade" }),
    contactId: text("contact_id")
      .notNull()
      .references(() => contacts.id, { onDelete: "cascade" }),
    currentStep: integer("current_step").notNull().default(0),
    /** enrolled | paused | completed | unsubscribed | errored */
    state: text("state").notNull().default("enrolled"),
    lastEventAt: timestamp("last_event_at", { withTimezone: true }),
    branchHistoryJson: jsonb("branch_history_json")
      .$type<Array<Record<string, unknown>>>()
      .notNull()
      .default([]),
    /** Populated when `state === 'errored'`. */
    error: text("error"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    tenantIdx: index("campaign_enrollments_tenant_idx").on(t.tenantId),
    campaignIdx: index("campaign_enrollments_campaign_idx").on(t.campaignId),
    contactIdx: index("campaign_enrollments_contact_idx").on(t.contactId),
    stateIdx: index("campaign_enrollments_state_idx").on(t.state),
    uniqEnrollment: uniqueIndex("campaign_enrollments_uniq").on(
      t.tenantId,
      t.campaignId,
      t.contactId,
    ),
  }),
);

export type CampaignEnrollment = typeof campaignEnrollments.$inferSelect;
export type NewCampaignEnrollment = typeof campaignEnrollments.$inferInsert;
