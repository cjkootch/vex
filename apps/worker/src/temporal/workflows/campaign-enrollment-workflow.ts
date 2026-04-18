import {
  condition,
  log,
  proxyActivities,
  setHandler,
  sleep,
} from "@temporalio/workflow";
import type { EnrollmentActivities } from "../activities/enrollment-activities.js";
import {
  approvalDecisionSignal,
  enrollmentControlSignal,
  enrollmentTouchpointSignal,
} from "../signals.js";

const activities = proxyActivities<EnrollmentActivities>({
  startToCloseTimeout: "60s",
  retry: {
    maximumAttempts: 3,
    initialInterval: "1s",
    backoffCoefficient: 2,
  },
});

export interface CampaignEnrollmentWorkflowInput {
  tenantId: string;
  enrollmentId: string;
}

export interface CampaignEnrollmentWorkflowResult {
  terminalState: "completed" | "unsubscribed" | "paused" | "errored";
  stepsDispatched: number;
  stepsSkipped: number;
}

/**
 * Per-enrollment workflow — one execution per
 * (campaign, contact) enrollment row. Walks the plan's steps in
 * order, waiting for each step's delay, evaluating its gate, and
 * dispatching through ApprovalGate.
 *
 * Signals the workflow handles at runtime:
 *   - enrollment.control (pause | resume | unsubscribe)
 *   - enrollment.touchpoint (event stream fed by the normalizer)
 *   - approval.decision (reviewer approved/rejected a step's approval)
 *
 * Deterministic — all clocks / DB / external calls go through
 * activities. Timeouts use Temporal's `sleep` so suspended workflows
 * survive worker restarts without skew.
 *
 * Approval timeout: step approvals expire after 7 days. A step whose
 * approval never resolves moves to `paused` with state=paused on the
 * enrollment row so the reviewer can investigate.
 */
const STEP_APPROVAL_TIMEOUT = "168h"; // 7 days

type SignalState = {
  /** Pending approval id for the currently-dispatching step, if any. */
  pendingApproval: string | null;
  /** Decision from the reviewer for the pending approval. */
  pendingDecision: "approved" | "rejected" | "auto_approved" | null;
  /** Control-signal requests that accumulated since last drain. */
  controlRequests: Array<{
    action: "pause" | "resume" | "unsubscribe";
    note?: string;
  }>;
  /** Runtime-accumulated touchpoint signals, in addition to the
   *  activity-loaded cache. */
  lastIntent: string | null;
  runtimeOpensIso: string[];
  runtimeClicksIso: string[];
  runtimeRepliesIso: string[];
};

export async function campaignEnrollmentWorkflow(
  input: CampaignEnrollmentWorkflowInput,
): Promise<CampaignEnrollmentWorkflowResult> {
  log.info("campaign_enrollment: start", {
    tenant_id: input.tenantId,
    enrollment_id: input.enrollmentId,
  });

  const signalState: SignalState = {
    pendingApproval: null,
    pendingDecision: null,
    controlRequests: [],
    lastIntent: null,
    runtimeOpensIso: [],
    runtimeClicksIso: [],
    runtimeRepliesIso: [],
  };

  setHandler(approvalDecisionSignal, (sig) => {
    if (signalState.pendingApproval === sig.approvalId) {
      signalState.pendingDecision = sig.decision;
    }
  });
  setHandler(enrollmentControlSignal, (sig) => {
    signalState.controlRequests.push({
      action: sig.action,
      ...(sig.note !== undefined ? { note: sig.note } : {}),
    });
  });
  setHandler(enrollmentTouchpointSignal, (sig) => {
    if (sig.kind === "email_open") signalState.runtimeOpensIso.push(sig.occurredAt);
    if (sig.kind === "email_click") signalState.runtimeClicksIso.push(sig.occurredAt);
    if (sig.kind === "inbound_reply") signalState.runtimeRepliesIso.push(sig.occurredAt);
    if (sig.kind === "intent_classified" && sig.intent) {
      signalState.lastIntent = sig.intent;
    }
  });

  const ctx = await activities.loadEnrollmentContext({
    enrollmentId: input.enrollmentId,
    tenantId: input.tenantId,
  });
  if (!ctx) {
    log.warn("campaign_enrollment: enrollment not found", {
      enrollment_id: input.enrollmentId,
    });
    return {
      terminalState: "errored",
      stepsDispatched: 0,
      stepsSkipped: 0,
    };
  }
  // Seed the runtime intent cache from the load.
  signalState.lastIntent = ctx.lastIntent;

  let stepsDispatched = 0;
  let stepsSkipped = 0;
  let currentStep = ctx.enrollment.currentStep;

  for (; currentStep < ctx.steps.length; currentStep++) {
    const step = ctx.steps[currentStep]!;

    // --- Control signal drain (before sleep so pauses take effect fast).
    const controlOutcome = drainControlRequests(signalState);
    if (controlOutcome === "unsubscribed") {
      await activities.transitionEnrollmentState({
        tenantId: input.tenantId,
        enrollmentId: input.enrollmentId,
        state: "unsubscribed",
      });
      return {
        terminalState: "unsubscribed",
        stepsDispatched,
        stepsSkipped,
      };
    }
    if (controlOutcome === "paused") {
      await activities.transitionEnrollmentState({
        tenantId: input.tenantId,
        enrollmentId: input.enrollmentId,
        state: "paused",
      });
      // Wait for resume — a paused enrollment blocks until the
      // operator sends an `enrollment.control` with action=resume.
      await condition(() =>
        signalState.controlRequests.some((r) => r.action === "resume") ||
        signalState.controlRequests.some((r) => r.action === "unsubscribe"),
      );
      const unsub = signalState.controlRequests.find((r) => r.action === "unsubscribe");
      if (unsub) {
        await activities.transitionEnrollmentState({
          tenantId: input.tenantId,
          enrollmentId: input.enrollmentId,
          state: "unsubscribed",
        });
        return {
          terminalState: "unsubscribed",
          stepsDispatched,
          stepsSkipped,
        };
      }
      await activities.transitionEnrollmentState({
        tenantId: input.tenantId,
        enrollmentId: input.enrollmentId,
        state: "enrolled",
      });
      signalState.controlRequests = signalState.controlRequests.filter(
        (r) => r.action !== "resume",
      );
    }

    if (step.delayAfterPriorMs > 0) await sleep(step.delayAfterPriorMs);

    // --- Gate evaluation against the merged (loaded + runtime) signal cache.
    const gate = await activities.evaluateStepGate({
      gateConditionJson: step.gateConditionJson,
      signals: mergedSignals(ctx, signalState),
      lastIntent: signalState.lastIntent,
      enrollmentState: "enrolled",
    });
    if (!gate.ok) {
      await activities.advanceEnrollmentStep({
        tenantId: input.tenantId,
        enrollmentId: input.enrollmentId,
        nextStep: currentStep + 1,
        historyEntry: {
          step_id: step.id,
          position: step.position,
          outcome: "skipped_gate",
          gate_reason: gate.reason,
        },
      });
      stepsSkipped++;
      continue;
    }

    // --- Dispatch.
    signalState.pendingApproval = null;
    signalState.pendingDecision = null;
    const dispatch = await activities.dispatchStep({
      tenantId: input.tenantId,
      enrollmentId: input.enrollmentId,
      step,
      contactId: ctx.enrollment.contactId,
    });
    if (dispatch.kind === "skipped") {
      await activities.advanceEnrollmentStep({
        tenantId: input.tenantId,
        enrollmentId: input.enrollmentId,
        nextStep: currentStep + 1,
        historyEntry: {
          step_id: step.id,
          position: step.position,
          outcome: "skipped_dispatch",
          skip_reason: dispatch.skipReason ?? "unknown",
        },
      });
      stepsSkipped++;
      continue;
    }

    if (dispatch.kind === "auto_approved") {
      await activities.advanceEnrollmentStep({
        tenantId: input.tenantId,
        enrollmentId: input.enrollmentId,
        nextStep: currentStep + 1,
        historyEntry: {
          step_id: step.id,
          position: step.position,
          outcome: "auto_approved",
          approval_id: dispatch.approvalId,
        },
      });
      stepsDispatched++;
      continue;
    }

    // --- Wait for reviewer decision (or unsubscribe / pause).
    signalState.pendingApproval = dispatch.approvalId;
    const decided = await Promise.race([
      condition(() =>
        signalState.pendingDecision !== null ||
        signalState.controlRequests.some((r) => r.action === "unsubscribe"),
      ).then(() => "signalled" as const),
      sleep(STEP_APPROVAL_TIMEOUT).then(() => "timed_out" as const),
    ]);

    const unsub = signalState.controlRequests.find((r) => r.action === "unsubscribe");
    if (unsub) {
      await activities.transitionEnrollmentState({
        tenantId: input.tenantId,
        enrollmentId: input.enrollmentId,
        state: "unsubscribed",
      });
      return {
        terminalState: "unsubscribed",
        stepsDispatched,
        stepsSkipped,
      };
    }

    if (decided === "timed_out") {
      // Reviewer never acted. Park the enrollment so a human can
      // pick it up rather than let the workflow bleed indefinitely.
      await activities.advanceEnrollmentStep({
        tenantId: input.tenantId,
        enrollmentId: input.enrollmentId,
        nextStep: currentStep, // stay here
        historyEntry: {
          step_id: step.id,
          position: step.position,
          outcome: "approval_timed_out",
          approval_id: dispatch.approvalId,
        },
      });
      await activities.transitionEnrollmentState({
        tenantId: input.tenantId,
        enrollmentId: input.enrollmentId,
        state: "paused",
        error: "step approval timed out after 168h",
      });
      return { terminalState: "paused", stepsDispatched, stepsSkipped };
    }

    const decision = signalState.pendingDecision;
    if (decision === "rejected") {
      await activities.advanceEnrollmentStep({
        tenantId: input.tenantId,
        enrollmentId: input.enrollmentId,
        nextStep: currentStep, // stay
        historyEntry: {
          step_id: step.id,
          position: step.position,
          outcome: "rejected",
          approval_id: dispatch.approvalId,
        },
      });
      await activities.transitionEnrollmentState({
        tenantId: input.tenantId,
        enrollmentId: input.enrollmentId,
        state: "paused",
        error: "reviewer rejected step approval",
      });
      return { terminalState: "paused", stepsDispatched, stepsSkipped };
    }

    // approved | auto_approved — advance.
    await activities.advanceEnrollmentStep({
      tenantId: input.tenantId,
      enrollmentId: input.enrollmentId,
      nextStep: currentStep + 1,
      historyEntry: {
        step_id: step.id,
        position: step.position,
        outcome: decision ?? "approved",
        approval_id: dispatch.approvalId,
      },
    });
    stepsDispatched++;
  }

  await activities.transitionEnrollmentState({
    tenantId: input.tenantId,
    enrollmentId: input.enrollmentId,
    state: "completed",
  });
  return { terminalState: "completed", stepsDispatched, stepsSkipped };
}

function drainControlRequests(state: SignalState): "unsubscribed" | "paused" | null {
  let outcome: "unsubscribed" | "paused" | null = null;
  for (const r of state.controlRequests) {
    if (r.action === "unsubscribe") return "unsubscribed";
    if (r.action === "pause") outcome = "paused";
  }
  // pause requests consumed; keep unsubscribe-semantics implicit via
  // the early-return above (we never return "paused" if an unsubscribe
  // was present).
  state.controlRequests = state.controlRequests.filter(
    (r) => r.action !== "pause",
  );
  return outcome;
}

function mergedSignals(
  ctx: { recentSignals: { emailOpensIso: string[]; emailClicksIso: string[]; inboundRepliesIso: string[] } },
  state: SignalState,
): {
  emailOpensIso: string[];
  emailClicksIso: string[];
  inboundRepliesIso: string[];
} {
  return {
    emailOpensIso: [
      ...ctx.recentSignals.emailOpensIso,
      ...state.runtimeOpensIso,
    ],
    emailClicksIso: [
      ...ctx.recentSignals.emailClicksIso,
      ...state.runtimeClicksIso,
    ],
    inboundRepliesIso: [
      ...ctx.recentSignals.inboundRepliesIso,
      ...state.runtimeRepliesIso,
    ],
  };
}

