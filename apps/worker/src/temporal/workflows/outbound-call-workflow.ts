import {
  condition,
  log,
  proxyActivities,
  setHandler,
  workflowInfo,
} from "@temporalio/workflow";
import type { CallActivities } from "../activities/call-activities.js";
import {
  approvalDecisionSignal,
  callRecordingSignal,
  callStatusSignal,
  type ApprovalDecisionSignal,
  type CallRecordingSignal,
  type CallStatusSignal,
} from "../signals.js";

// ---------------------------------------------------------------------------
// Activity proxies — default retry for the lightweight checks; short
// schedule-to-close on createTwilioCall per the spec (calls are
// synchronous-ish; we want a quick failure if Twilio is flaking).
// ---------------------------------------------------------------------------

const checks = proxyActivities<CallActivities>({
  startToCloseTimeout: "20s",
  retry: {
    maximumAttempts: 3,
    initialInterval: "1s",
    backoffCoefficient: 2,
  },
});

const dial = proxyActivities<CallActivities>({
  scheduleToCloseTimeout: "30s",
  startToCloseTimeout: "30s",
  retry: {
    maximumAttempts: 2,
    initialInterval: "10s",
    backoffCoefficient: 2,
  },
});

const store = proxyActivities<CallActivities>({
  startToCloseTimeout: "2m",
  retry: {
    maximumAttempts: 4,
    initialInterval: "2s",
    backoffCoefficient: 2,
  },
});

const long = proxyActivities<CallActivities>({
  startToCloseTimeout: "5m",
  retry: {
    maximumAttempts: 3,
    initialInterval: "2s",
    backoffCoefficient: 2,
  },
});

// ---------------------------------------------------------------------------
// Workflow I/O
// ---------------------------------------------------------------------------

export interface OutboundCallWorkflowInput {
  tenantId: string;
  workspaceId: string;
  contactId: string;
  orgId: string;
  toNumber: string;
  agentRunId: string;
  initiatedByUserId: string;
  /**
   * Enforce the 08:00-18:00 local calling window on this run. Default
   * `false` — a user pressing "call" at 9pm is expressing consent, so
   * we shouldn't silently veto. Flip to `true` for scheduled / agent-
   * initiated calls that run without a human in front of them.
   */
  respectCallWindow?: boolean;
  /**
   * Sprint L2 — when true, Twilio fetches the AI-talkback TwiML variant
   * (Pause + Connect + Stream) instead of the conference bridge, and
   * Vex holds the conversation directly. Default false preserves the
   * existing operator-join conference flow.
   */
  aiMode?: boolean;
}

export type OutboundCallOutcome =
  | { kind: "rejected_outside_window"; reason: string }
  | { kind: "rejected_suppressed"; reason: string }
  | { kind: "expired_no_approval"; approvalId: string }
  | { kind: "rejected_by_reviewer"; approvalId: string; reviewerId: string; reason?: string }
  | { kind: "expired_no_call_status"; callSid: string; approvalId: string }
  | {
      kind: "completed";
      callSid: string;
      approvalId: string;
      activityId: string;
      summaryId: string;
      durationSeconds: number;
    }
  | {
      kind: "completed_no_recording";
      callSid: string;
      approvalId: string;
      activityId: string;
      durationSeconds: number;
    };

// Timeouts per spec:
const APPROVAL_WAIT = "24h";
const CALL_STATUS_WAIT = "3h";
const RECORDING_WAIT = "10m";

// ---------------------------------------------------------------------------
// Workflow
// ---------------------------------------------------------------------------

/**
 * Outbound PSTN call orchestration. Runs entirely on the Temporal side
 * so the T3 approval gate can't be short-circuited by a service
 * restart. Every Twilio interaction is an activity so the workflow
 * code stays pure / deterministic.
 *
 * State machine:
 *   1. checkCallWindow        — 08:00-18:00 local gate
 *   2. checkSuppression       — contact.opt_out_at gate
 *   3. createApprovalRow      — writes T3 approval; the HTTP 200 to the
 *                                operator returns here
 *   wait 24h for approval.decision signal
 *     timeout → call.expired.no_approval audit + return
 *     rejected → call.rejected.by_reviewer audit + return
 *     approved → continue
 *   4. createTwilioCall       — fires the actual Twilio REST call
 *   wait 3h for terminal call.status.update signal
 *     timeout → call.expired.no_call_status audit + return
 *   5. wait ≤10m for call.recording.available signal
 *   6. fetchAndStoreRecording — downloads + stores, attaches to activity
 *   7. processTranscript      — summary + touchpoint + T2 action items
 *   8. emitAuditEvent         — call.completed
 *
 * All audit events use deterministic idempotency keys so re-run of a
 * history fragment doesn't duplicate rows.
 */
export async function outboundCallWorkflow(
  input: OutboundCallWorkflowInput,
): Promise<OutboundCallOutcome> {
  const wf = workflowInfo();
  const workflowId = wf.workflowId;

  log.info("outbound_call workflow started", {
    tenant_id: input.tenantId,
    contact_id: input.contactId,
    workflow_id: workflowId,
  });

  // --- Step 1: call window ------------------------------------------------
  // Only enforced when `respectCallWindow` is explicitly set — scheduled
  // / autonomous agent runs should still honour it. Human-triggered
  // flows (chat "call X now", /calls POST) opt out so a 9pm click
  // actually dials; the operator's consent is already on-screen.
  if (input.respectCallWindow) {
    const windowCheck = await checks.checkCallWindow({
      tenantId: input.tenantId,
      contactId: input.contactId,
    });
    if (!windowCheck.allowed) {
      await long.emitAuditEvent({
        tenantId: input.tenantId,
        verb: "call.rejected.outside_window",
        subjectType: "contact",
        subjectId: input.contactId,
        idempotencyKey: `call.rejected.outside_window:${workflowId}`,
        metadata: {
          reason: windowCheck.reason ?? "outside window",
          timezone: windowCheck.contactTimezone,
          local_hour: windowCheck.localHour,
          workflow_id: workflowId,
        },
      });
      return {
        kind: "rejected_outside_window",
        reason: windowCheck.reason ?? "outside window",
      };
    }
  }

  // --- Step 2: suppression ------------------------------------------------
  const suppressed = await checks.checkSuppression({
    tenantId: input.tenantId,
    contactId: input.contactId,
  });
  if (suppressed.suppressed) {
    await long.emitAuditEvent({
      tenantId: input.tenantId,
      verb: "call.rejected.suppressed",
      subjectType: "contact",
      subjectId: input.contactId,
      idempotencyKey: `call.rejected.suppressed:${workflowId}`,
      metadata: {
        reason: suppressed.reason ?? "contact opted out",
        opt_out_at: suppressed.optOutAt ?? null,
        workflow_id: workflowId,
      },
    });
    return {
      kind: "rejected_suppressed",
      reason: suppressed.reason ?? "contact opted out",
    };
  }

  // --- Step 3: approval row -----------------------------------------------
  const { approvalId } = await checks.createApprovalRow({
    tenantId: input.tenantId,
    agentRunId: input.agentRunId,
    workflowId,
    contactId: input.contactId,
    orgId: input.orgId,
    toNumber: input.toNumber,
    initiatedByUserId: input.initiatedByUserId,
  });

  // --- Wait for approval.decision ----------------------------------------
  let decision: ApprovalDecisionSignal | null = null;
  setHandler(approvalDecisionSignal, (sig) => {
    if (sig.approvalId === approvalId) decision = sig;
  });
  const gotDecision = await condition(() => decision !== null, APPROVAL_WAIT);
  if (!gotDecision || !decision) {
    await long.emitAuditEvent({
      tenantId: input.tenantId,
      verb: "call.expired.no_approval",
      subjectType: "approval",
      subjectId: approvalId,
      idempotencyKey: `call.expired.no_approval:${workflowId}`,
      metadata: { workflow_id: workflowId },
    });
    return { kind: "expired_no_approval", approvalId };
  }
  const decided = decision as ApprovalDecisionSignal;
  if (decided.decision === "rejected") {
    await long.emitAuditEvent({
      tenantId: input.tenantId,
      verb: "call.rejected.by_reviewer",
      subjectType: "approval",
      subjectId: approvalId,
      idempotencyKey: `call.rejected.by_reviewer:${workflowId}`,
      metadata: {
        workflow_id: workflowId,
        reviewer_id: decided.reviewerId,
        ...(decided.reason ? { reason: decided.reason } : {}),
      },
    });
    const out: OutboundCallOutcome = {
      kind: "rejected_by_reviewer",
      approvalId,
      reviewerId: decided.reviewerId,
    };
    if (decided.reason !== undefined) out.reason = decided.reason;
    return out;
  }

  // --- Step 4: dial Twilio ------------------------------------------------
  const { callSid, activityId } = await dial.createTwilioCall({
    tenantId: input.tenantId,
    contactId: input.contactId,
    orgId: input.orgId,
    workflowId,
    agentRunId: input.agentRunId,
    toNumber: input.toNumber,
    approvalId,
    ...(input.aiMode ? { aiMode: true } : {}),
  });

  // --- Wait for a terminal call status ------------------------------------
  let finalStatus: CallStatusSignal | null = null;
  setHandler(callStatusSignal, (sig) => {
    if (sig.callSid !== callSid) return;
    if (isTerminalStatus(sig.status)) finalStatus = sig;
  });
  const gotStatus = await condition(
    () => finalStatus !== null,
    CALL_STATUS_WAIT,
  );
  if (!gotStatus || !finalStatus) {
    await long.emitAuditEvent({
      tenantId: input.tenantId,
      verb: "call.expired.no_call_status",
      subjectType: "activity",
      subjectId: activityId,
      idempotencyKey: `call.expired.no_call_status:${workflowId}`,
      metadata: { workflow_id: workflowId, call_sid: callSid },
    });
    return {
      kind: "expired_no_call_status",
      callSid,
      approvalId,
    };
  }
  const statusFinal = finalStatus as CallStatusSignal;
  const durationSeconds = statusFinal.durationSeconds ?? 0;

  // --- Step 5: wait for recording ----------------------------------------
  let recording: CallRecordingSignal | null = null;
  setHandler(callRecordingSignal, (sig) => {
    if (sig.callSid === callSid) recording = sig;
  });
  const gotRecording = await condition(
    () => recording !== null,
    RECORDING_WAIT,
  );
  if (!gotRecording || !recording) {
    // Call completed but no recording callback — still a successful
    // outcome, just without transcript processing.
    await long.emitAuditEvent({
      tenantId: input.tenantId,
      verb: "call.completed.no_recording",
      subjectType: "activity",
      subjectId: activityId,
      idempotencyKey: `call.completed.no_recording:${workflowId}`,
      metadata: {
        workflow_id: workflowId,
        call_sid: callSid,
        final_status: statusFinal.status,
        duration_seconds: durationSeconds,
      },
    });
    return {
      kind: "completed_no_recording",
      callSid,
      approvalId,
      activityId,
      durationSeconds,
    };
  }
  const rec = recording as CallRecordingSignal;

  // --- Step 6: store recording (idempotent even though the webhook
  //     already uploaded, to populate activity.transcript_ref cleanly).
  const stored = await store.fetchAndStoreRecording({
    tenantId: input.tenantId,
    callSid,
    recordingSid: rec.recordingSid,
    recordingUrl: rec.storageKey, // already an S3 key; activity tolerates
    durationSeconds: rec.durationSeconds,
    contactId: input.contactId,
    orgId: input.orgId,
    agentRunId: input.agentRunId,
  });

  // --- Step 7: transcript processing -------------------------------------
  const transcriptText = rec.transcriptText ?? "";
  const processed = await long.processTranscript({
    tenantId: input.tenantId,
    workspaceId: input.workspaceId,
    activityId: stored.activityId,
    callSid,
    transcriptText,
    durationSeconds: rec.durationSeconds,
    orgId: input.orgId,
    contactId: input.contactId,
  });

  // --- Step 8: final audit -----------------------------------------------
  await long.emitAuditEvent({
    tenantId: input.tenantId,
    verb: "call.completed",
    subjectType: "activity",
    subjectId: stored.activityId,
    idempotencyKey: `call.completed:${workflowId}`,
    metadata: {
      workflow_id: workflowId,
      call_sid: callSid,
      duration_seconds: rec.durationSeconds,
      storage_key: stored.storageKey,
      summary_id: processed.summaryId,
      action_item_approvals: processed.actionItemApprovalIds.length,
    },
  });

  return {
    kind: "completed",
    callSid,
    approvalId,
    activityId: stored.activityId,
    summaryId: processed.summaryId,
    durationSeconds: rec.durationSeconds,
  };
}

function isTerminalStatus(status: CallStatusSignal["status"]): boolean {
  return (
    status === "completed" ||
    status === "busy" ||
    status === "failed" ||
    status === "no-answer" ||
    status === "canceled"
  );
}
