import { index, jsonb, pgTable, text, timestamp } from "drizzle-orm/pg-core";
import { approvalDecisionEnum } from "./enums.js";
import { agentRuns } from "./agent-runs.js";
import { users } from "./users.js";

/**
 * Per invariant: T2+ actions MUST NOT execute without an approval row whose
 * `decision` is `approved` (or `auto_approved` for whitelisted automation).
 * `proposed_payload` captures the typed `ActionDescriptor` from
 * `@vex/agents` so reviewers see exactly what they're approving.
 */
export const approvals = pgTable(
  "approvals",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id").notNull(),
    agentRunId: text("agent_run_id").references(() => agentRuns.id, {
      onDelete: "set null",
    }),
    actionType: text("action_type").notNull(),
    proposedPayload: jsonb("proposed_payload")
      .$type<Record<string, unknown>>()
      .notNull(),
    reviewerId: text("reviewer_id").references(() => users.id, {
      onDelete: "set null",
    }),
    decision: approvalDecisionEnum("decision").notNull().default("pending"),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    tenantIdx: index("approvals_tenant_idx").on(t.tenantId),
    statusIdx: index("approvals_decision_idx").on(t.decision),
  }),
);

export type Approval = typeof approvals.$inferSelect;
export type NewApproval = typeof approvals.$inferInsert;
