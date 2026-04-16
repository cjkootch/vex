import { defineSignal } from "@temporalio/workflow";

/** Sent by `apps/api` when a reviewer decides on an approval. */
export interface ApprovalDecisionSignal {
  approvalId: string;
  decision: "approved" | "rejected";
  reviewerId: string;
  reason?: string;
}

export const approvalDecisionSignal = defineSignal<[ApprovalDecisionSignal]>(
  "approval.decision",
);
