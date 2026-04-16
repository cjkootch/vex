import { pgTable, uuid, text, timestamp, pgEnum, jsonb } from "drizzle-orm/pg-core";
import { ApprovalDecision, ApprovalTier } from "@vex/domain";
import { tenants } from "./tenants.js";
import { users } from "./users.js";

export const approvalTierEnum = pgEnum("approval_tier", [
  ApprovalTier.T0,
  ApprovalTier.T1,
  ApprovalTier.T2,
  ApprovalTier.T3,
]);

export const approvalDecisionEnum = pgEnum("approval_decision", [
  ApprovalDecision.Pending,
  ApprovalDecision.Approved,
  ApprovalDecision.Rejected,
  ApprovalDecision.Expired,
]);

/**
 * Per invariant: T2+ approval actions never execute without an approval row
 * whose decision = 'approved'. The `action` column captures a typed descriptor
 * of what will be executed so the reviewer sees exactly what they're approving.
 */
export const approvals = pgTable("approvals", {
  id: uuid("id").primaryKey().defaultRandom(),
  tenantId: uuid("tenant_id")
    .notNull()
    .references(() => tenants.id, { onDelete: "cascade" }),
  requestedBy: uuid("requested_by").references(() => users.id),
  decidedBy: uuid("decided_by").references(() => users.id),
  tier: approvalTierEnum("tier").notNull(),
  decision: approvalDecisionEnum("decision").notNull().default(ApprovalDecision.Pending),
  action: jsonb("action").notNull(),
  reason: text("reason"),
  requestedAt: timestamp("requested_at", { withTimezone: true }).notNull().defaultNow(),
  decidedAt: timestamp("decided_at", { withTimezone: true }),
  expiresAt: timestamp("expires_at", { withTimezone: true }),
});
