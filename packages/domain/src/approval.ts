/**
 * Approval tiers.
 *
 * Actions are classified by risk. Per invariants, T2+ actions MUST NOT execute
 * without a corresponding approval row with decision=approved.
 */
export const ApprovalTier = {
  /** Read-only / reversible within the user's own view. */
  T0: "T0",
  /** Writes to internal state (notes, drafts). */
  T1: "T1",
  /** External writes (sends email, logs CRM activity) — requires approval. */
  T2: "T2",
  /** Irreversible or high-blast external writes (close opportunity, bulk email). */
  T3: "T3",
} as const;
export type ApprovalTier = (typeof ApprovalTier)[keyof typeof ApprovalTier];

export const ApprovalDecision = {
  Pending: "pending",
  Approved: "approved",
  Rejected: "rejected",
  Expired: "expired",
} as const;
export type ApprovalDecision = (typeof ApprovalDecision)[keyof typeof ApprovalDecision];

/**
 * True iff the given tier may execute without an approval row. Callers MUST
 * consult an actual approval record for anything where this returns false —
 * this helper only encodes the tier classification.
 */
export function requiresApproval(tier: ApprovalTier): boolean {
  return tier === ApprovalTier.T2 || tier === ApprovalTier.T3;
}
