import { z } from "zod";
import { ApprovalTier, requiresApproval, type ApprovalTier as ApprovalTierT } from "@vex/domain";

/**
 * Typed descriptor for an action an agent wants to take. The descriptor is
 * what gets stored on the `approvals.action` column so reviewers see exactly
 * what they're approving — no free-form strings or raw tool-call blobs.
 */
export const ActionDescriptor = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("email.send"),
    tier: z.literal(ApprovalTier.T2),
    to: z.array(z.string().email()).min(1),
    subject: z.string().min(1),
    body: z.string().min(1),
  }),
  z.object({
    kind: z.literal("crm.note"),
    tier: z.literal(ApprovalTier.T1),
    accountId: z.string().uuid(),
    body: z.string().min(1),
  }),
  z.object({
    kind: z.literal("opportunity.close"),
    tier: z.literal(ApprovalTier.T3),
    opportunityId: z.string().uuid(),
    outcome: z.enum(["won", "lost"]),
    reason: z.string().min(1),
  }),
]);

export type ActionDescriptorT = z.infer<typeof ActionDescriptor>;

/**
 * Returns true iff executing the action requires a decided-approved approval
 * row. The tier is captured on the descriptor itself so it can't drift from
 * the action shape.
 */
export function actionRequiresApproval(action: ActionDescriptorT): boolean {
  const tier: ApprovalTierT = action.tier;
  return requiresApproval(tier);
}
