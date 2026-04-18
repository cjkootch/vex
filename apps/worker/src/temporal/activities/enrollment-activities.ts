import {
  withTenant,
  type ApprovalRepository,
  type CampaignEnrollmentRepository,
  type CampaignStepRepository,
  type ContactRepository,
  type Db,
  type EventRepository,
  type TouchpointRepository,
} from "@vex/db";
import {
  evaluateGate,
  type GateContext,
  type GateNode,
  type GateResult,
} from "@vex/agents";
import { createLogger, withSpan } from "@vex/telemetry";

const log = createLogger("worker.enrollment");

/**
 * Activities the `CampaignEnrollmentWorkflow` (Sprint D) invokes.
 * Kept as a thin DB + ApprovalGate shim — all branching logic lives
 * in the workflow so Temporal's replay invariants stay intact.
 *
 * Every activity is idempotent: workers may be killed between attempt
 * and record so Temporal routinely re-invokes the same activity with
 * the same args. Side effects must tolerate re-running.
 */

export interface EnrollmentActivitiesDeps {
  db: Db;
  enrollments: CampaignEnrollmentRepository;
  steps: CampaignStepRepository;
  approvals: ApprovalRepository;
  touchpoints: TouchpointRepository;
  contacts: ContactRepository;
  events: EventRepository;
}

export interface WorkflowEnrollmentRow {
  id: string;
  tenantId: string;
  campaignId: string;
  contactId: string;
  currentStep: number;
  state: string;
  lastEventAt: string | null;
  error: string | null;
  branchHistory: Array<Record<string, unknown>>;
}

export interface WorkflowStepRow {
  id: string;
  position: number;
  channel: string;
  delayAfterPriorMs: number;
  templateRef: string | null;
  gateConditionJson: Record<string, unknown>;
  tier: string;
  autoApprove: boolean;
}

export interface EnrollmentContext {
  enrollment: WorkflowEnrollmentRow;
  steps: WorkflowStepRow[];
  /**
   * Signal cache — recent touchpoint timestamps keyed by kind, built
   * from the contact's touchpoint history on load. The workflow
   * appends to this at runtime via `enrollmentTouchpointSignal`.
   */
  recentSignals: {
    emailOpensIso: string[];
    emailClicksIso: string[];
    inboundRepliesIso: string[];
  };
  /** Last classified intent on an inbound touchpoint (if any). */
  lastIntent: string | null;
}

export interface DispatchResult {
  kind: "approval_created" | "auto_approved" | "skipped";
  /** Approval row id when an approval was created or auto-applied. */
  approvalId: string | null;
  /** Present when kind === "skipped". */
  skipReason?: string;
}

const TOUCHPOINT_LOOKBACK_DAYS = 30;

export function buildEnrollmentActivities(deps: EnrollmentActivitiesDeps) {
  return {
    /**
     * Load enrollment + plan + recent signals. Called once at workflow
     * start (plus after recovery on worker restart).
     */
    async loadEnrollmentContext(input: {
      enrollmentId: string;
      tenantId: string;
    }): Promise<EnrollmentContext | null> {
      return withSpan(
        "temporal.activity.loadEnrollmentContext",
        { enrollment_id: input.enrollmentId, tenant_id: input.tenantId },
        async () =>
          withTenant(deps.db, input.tenantId, async (tx) => {
            const enrollment = await deps.enrollments.findById(
              tx,
              input.enrollmentId,
            );
            if (!enrollment) return null;
            const steps = await deps.steps.listByCampaign(
              tx,
              enrollment.campaignId,
            );

            const since = new Date(
              Date.now() - TOUCHPOINT_LOOKBACK_DAYS * 86_400_000,
            );
            const recent = await deps.touchpoints.listForContactSince(
              tx,
              enrollment.contactId,
              since,
              200,
            );
            const emailOpensIso: string[] = [];
            const emailClicksIso: string[] = [];
            const inboundRepliesIso: string[] = [];
            let lastIntent: string | null = null;
            for (const t of recent) {
              const verb = typeof t.metadata["verb"] === "string"
                ? (t.metadata["verb"] as string)
                : "";
              const occurredAt = t.occurredAt.toISOString();
              if (verb === "email.opened") emailOpensIso.push(occurredAt);
              if (verb === "email.clicked") emailClicksIso.push(occurredAt);
              if (t.metadata["direction"] === "inbound") {
                inboundRepliesIso.push(occurredAt);
              }
              const intent = t.metadata["intent"];
              if (typeof intent === "string" && intent.length > 0) {
                lastIntent = intent;
              }
            }

            return {
              enrollment: {
                id: enrollment.id,
                tenantId: enrollment.tenantId,
                campaignId: enrollment.campaignId,
                contactId: enrollment.contactId,
                currentStep: enrollment.currentStep,
                state: enrollment.state,
                lastEventAt: enrollment.lastEventAt
                  ? enrollment.lastEventAt.toISOString()
                  : null,
                error: enrollment.error,
                branchHistory: enrollment.branchHistoryJson,
              },
              steps: steps.map((s) => ({
                id: s.id,
                position: s.position,
                channel: s.channel,
                delayAfterPriorMs: s.delayAfterPriorMs,
                templateRef: s.templateRef,
                gateConditionJson: s.gateConditionJson,
                tier: s.tier,
                autoApprove: s.autoApprove,
              })),
              recentSignals: {
                emailOpensIso,
                emailClicksIso,
                inboundRepliesIso,
              },
              lastIntent,
            } satisfies EnrollmentContext;
          }),
      );
    },

    /**
     * Evaluate the step's gate condition against the current signal
     * cache. The workflow calls this after each delay, right before
     * dispatch — the evaluator is pure so the result is fully
     * replayable.
     */
    async evaluateStepGate(input: {
      gateConditionJson: Record<string, unknown>;
      signals: {
        emailOpensIso: string[];
        emailClicksIso: string[];
        inboundRepliesIso: string[];
      };
      lastIntent: string | null;
      enrollmentState: string;
    }): Promise<GateResult> {
      const ctx: GateContext = {
        lastIntent: input.lastIntent,
        recentSignals: {
          emailOpens: input.signals.emailOpensIso.map((t) => new Date(t)),
          emailClicks: input.signals.emailClicksIso.map((t) => new Date(t)),
          inboundReplies: input.signals.inboundRepliesIso.map(
            (t) => new Date(t),
          ),
        },
        enrollmentState: input.enrollmentState,
      };
      return evaluateGate(
        input.gateConditionJson as unknown as GateNode,
        ctx,
      );
    },

    /**
     * Dispatch a step: when `autoApprove` is true, create an approval
     * row already flagged `approved` so the approval-executor fires
     * the side effect immediately. Otherwise, create a pending
     * approval — the workflow then waits for the decision signal.
     *
     * The approval's proposed_payload mirrors the step's `channel` +
     * `templateRef` so the existing email.send / sms.send /
     * whatsapp.send executor branches (Sprints A + B) pick it up.
     */
    async dispatchStep(input: {
      tenantId: string;
      enrollmentId: string;
      step: WorkflowStepRow;
      contactId: string;
    }): Promise<DispatchResult> {
      const actionType = channelToActionType(input.step.channel);
      if (!actionType) {
        log.warn("dispatchStep: no action type for channel", {
          enrollment_id: input.enrollmentId,
          channel: input.step.channel,
        });
        return { kind: "skipped", approvalId: null, skipReason: "manual_or_unknown_channel" };
      }

      return withTenant(deps.db, input.tenantId, async (tx) => {
        const approval = await deps.approvals.create(tx, input.tenantId, {
          agentRunId: null,
          actionType,
          proposedPayload: {
            tier: input.step.tier,
            enrollment_id: input.enrollmentId,
            step_id: input.step.id,
            step_position: input.step.position,
            template_ref: input.step.templateRef,
            contact_id: input.contactId,
            auto_approved: input.step.autoApprove,
          },
        });

        if (input.step.autoApprove) {
          await deps.approvals.decide(
            tx,
            approval.id,
            "auto_approved",
            null,
          );
          await deps.events.insertIfNotExists(tx, input.tenantId, {
            verb: "enrollment.step.auto_approved",
            subjectType: "campaign_enrollment",
            subjectId: input.enrollmentId,
            actorType: "system",
            actorId: "campaign_enrollment_workflow",
            objectType: "approval",
            objectId: approval.id,
            occurredAt: new Date(),
            idempotencyKey: `enrollment.step.auto_approved:${input.enrollmentId}:${input.step.id}`,
            metadata: {
              enrollment_id: input.enrollmentId,
              step_id: input.step.id,
              action_type: actionType,
            },
          });
          return { kind: "auto_approved", approvalId: approval.id };
        }

        await deps.events.insertIfNotExists(tx, input.tenantId, {
          verb: "enrollment.step.approval_created",
          subjectType: "campaign_enrollment",
          subjectId: input.enrollmentId,
          actorType: "system",
          actorId: "campaign_enrollment_workflow",
          objectType: "approval",
          objectId: approval.id,
          occurredAt: new Date(),
          idempotencyKey: `enrollment.step.approval_created:${input.enrollmentId}:${input.step.id}`,
          metadata: {
            enrollment_id: input.enrollmentId,
            step_id: input.step.id,
            action_type: actionType,
          },
        });
        return { kind: "approval_created", approvalId: approval.id };
      });
    },

    async advanceEnrollmentStep(input: {
      tenantId: string;
      enrollmentId: string;
      nextStep: number;
      historyEntry: Record<string, unknown>;
    }): Promise<void> {
      await withTenant(deps.db, input.tenantId, async (tx) => {
        await deps.enrollments.advanceStep(
          tx,
          input.enrollmentId,
          input.nextStep,
          input.historyEntry,
        );
      });
    },

    async transitionEnrollmentState(input: {
      tenantId: string;
      enrollmentId: string;
      state: string;
      error?: string;
    }): Promise<void> {
      await withTenant(deps.db, input.tenantId, async (tx) => {
        await deps.enrollments.transitionState(
          tx,
          input.enrollmentId,
          input.state,
          input.error,
        );
        await deps.events.insertIfNotExists(tx, input.tenantId, {
          verb: "enrollment.state_changed",
          subjectType: "campaign_enrollment",
          subjectId: input.enrollmentId,
          actorType: "system",
          actorId: "campaign_enrollment_workflow",
          objectType: "campaign_enrollment",
          objectId: input.enrollmentId,
          occurredAt: new Date(),
          idempotencyKey: `enrollment.state_changed:${input.enrollmentId}:${input.state}:${Date.now()}`,
          metadata: {
            state: input.state,
            error: input.error ?? null,
          },
        });
      });
    },
  };
}

export type EnrollmentActivities = ReturnType<typeof buildEnrollmentActivities>;

/**
 * Map a campaign step channel to an approval action type the existing
 * executor branches know about.
 *   email    → email.send (Sprint A)
 *   sms      → sms.send (Sprint B)
 *   whatsapp → whatsapp.send (Sprint B)
 *   voice    → outbound_call (Sprint 12)
 *   manual   → null — executor stays a no-op; the workflow still
 *              advances + records history so operators can see the
 *              step landed.
 */
function channelToActionType(channel: string): string | null {
  switch (channel) {
    case "email":
      return "email.send";
    case "sms":
      return "sms.send";
    case "whatsapp":
      return "whatsapp.send";
    case "voice":
      return "outbound_call";
    default:
      return null;
  }
}
