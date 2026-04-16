import {
  condition,
  log,
  proxyActivities,
  setHandler,
} from "@temporalio/workflow";
import type { FollowUpActivities } from "../activities/follow-up-activities.js";
import { approvalDecisionSignal, type ApprovalDecisionSignal } from "../signals.js";

const activities = proxyActivities<FollowUpActivities>({
  startToCloseTimeout: "60s",
  retry: {
    maximumAttempts: 3,
    initialInterval: "1s",
    backoffCoefficient: 2,
  },
});

/** Workflow input — a single agent_run id under which the suggestions land. */
export interface FollowUpWorkflowInput {
  tenantId: string;
  agentRunId: string;
}

export interface FollowUpWorkflowResult {
  approvalsCreated: number;
  approved: string[];
  rejected: string[];
  expired: string[];
}

/**
 * One workflow execution per follow-up scan. The flow:
 *
 *   1. queryStaleItems     — find threads/leads that need a nudge
 *   2. generateFollowUpDrafts — Claude drafts one suggestion per item
 *   3. createApprovalRows  — N approval rows (decision=pending)
 *   4. Wait up to 72h for the API to send `approval.decision` signals.
 *      Each signal carries an `approvalId` so we track decisions in a
 *      map and resolve once every approval is decided.
 *   5. Per approval: markDraftReady (approved) or logRejection (rejected)
 *      or expireApproval (timeout).
 *
 * Workflow code is sandboxed and deterministic — no Date.now(), no I/O,
 * no shared state. All side effects go through activities.
 */
export async function followUpWorkflow(
  input: FollowUpWorkflowInput,
): Promise<FollowUpWorkflowResult> {
  log.info("follow_up workflow started", {
    tenant_id: input.tenantId,
    agent_run_id: input.agentRunId,
  });

  const stale = await activities.queryStaleItems({ tenantId: input.tenantId });
  if (stale.length === 0) {
    log.info("follow_up: no stale items");
    return { approvalsCreated: 0, approved: [], rejected: [], expired: [] };
  }

  const drafts = await activities.generateFollowUpDrafts({
    tenantId: input.tenantId,
    agentRunId: input.agentRunId,
    staleItems: stale,
  });
  if (drafts.length === 0) {
    log.info("follow_up: no defensible drafts produced");
    return { approvalsCreated: 0, approved: [], rejected: [], expired: [] };
  }

  const approvals = await activities.createApprovalRows({
    tenantId: input.tenantId,
    agentRunId: input.agentRunId,
    drafts,
  });
  const approvalIds = new Set(approvals.map((a) => a.approvalId));

  const decisions = new Map<string, ApprovalDecisionSignal>();
  setHandler(approvalDecisionSignal, (signal) => {
    if (approvalIds.has(signal.approvalId)) {
      decisions.set(signal.approvalId, signal);
    }
  });

  // Wait up to 72h for every approval to be decided. `condition` resolves
  // `true` if the predicate becomes true; `false` on timeout. Either way
  // we drain into the per-approval branches below.
  await condition(() => decisions.size === approvalIds.size, "72h");

  const approved: string[] = [];
  const rejected: string[] = [];
  const expired: string[] = [];

  for (const id of approvalIds) {
    const decision = decisions.get(id);
    if (!decision) {
      await activities.expireApproval({ tenantId: input.tenantId, approvalId: id });
      expired.push(id);
      continue;
    }
    if (decision.decision === "approved") {
      await activities.markDraftReady({ tenantId: input.tenantId, approvalId: id });
      approved.push(id);
    } else {
      await activities.logRejection({
        tenantId: input.tenantId,
        approvalId: id,
        reason: decision.reason ?? "",
      });
      rejected.push(id);
    }
  }

  return {
    approvalsCreated: approvals.length,
    approved,
    rejected,
    expired,
  };
}
