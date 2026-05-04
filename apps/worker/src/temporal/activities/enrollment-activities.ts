import {
  withTenant,
  type ApprovalRepository,
  type CampaignEnrollmentRepository,
  type CampaignStepRepository,
  type ContactRepository,
  type Db,
  type EventRepository,
  type OrganizationRepository,
  type TouchpointRepository,
  type WorkspaceRepository,
  type WorkspaceSettings,
  type Contact,
} from "@vex/db";
import {
  evaluateGate,
  substituteTemplate,
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
  organizations: OrganizationRepository;
  events: EventRepository;
  /**
   * Read-only settings access for template lookup. Workflow dispatch
   * resolves the named template + renders {{variables}} from the
   * recipient context before writing the approval payload, so
   * downstream executors stay unchanged.
   */
  workspaces: WorkspaceRepository;
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
  subjectOverride: string | null;
  bodyOverride: string | null;
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
                subjectOverride: s.subjectOverride,
                bodyOverride: s.bodyOverride,
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
     * Dispatch a step: resolve the actual channel-specific payload
     * (subject + body for email, body + to for SMS / WhatsApp,
     * aiInstructions + toNumber for outbound_call) by looking up the
     * named template OR rendering the inline override, then create an
     * approval whose proposed_payload is what the executor branches
     * (applyEmailSend / applyMessageSend / applyOutboundCall) already
     * expect to consume — no executor changes needed.
     *
     * If the step is misconfigured (no template AND no override, OR
     * the named template doesn't exist in the registry, OR a required
     * variable can't be resolved from contact context), dispatch fails
     * loud with a `skipped` result and a logged reason; the workflow
     * advances past the broken step rather than stalling forever.
     */
    async dispatchStep(input: {
      tenantId: string;
      enrollmentId: string;
      step: WorkflowStepRow;
      contactId: string;
    }): Promise<DispatchResult> {
      const channelActionType = channelToActionType(input.step.channel);
      if (!channelActionType) {
        log.warn("dispatchStep: no action type for channel", {
          enrollment_id: input.enrollmentId,
          channel: input.step.channel,
        });
        return { kind: "skipped", approvalId: null, skipReason: "manual_or_unknown_channel" };
      }

      // Resolve the rendered content + final actionType. WhatsApp
      // template steps flip `whatsapp.send` → `whatsapp.send_template`
      // because the executor branch is different.
      let resolved: ResolvedStepPayload;
      try {
        resolved = await resolveStepPayload(deps, {
          tenantId: input.tenantId,
          contactId: input.contactId,
          step: input.step,
          channelActionType,
        });
      } catch (err) {
        const reason = (err as Error).message;
        log.warn("dispatchStep: payload resolution failed", {
          enrollment_id: input.enrollmentId,
          step_id: input.step.id,
          channel: input.step.channel,
          reason,
        });
        return { kind: "skipped", approvalId: null, skipReason: reason };
      }

      return withTenant(deps.db, input.tenantId, async (tx) => {
        const approval = await deps.approvals.create(tx, input.tenantId, {
          agentRunId: null,
          actionType: resolved.actionType,
          proposedPayload: {
            ...resolved.payload,
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
              action_type: resolved.actionType,
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
            action_type: resolved.actionType,
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

interface ResolvedStepPayload {
  /**
   * Final actionType for the approval. Usually matches the channel
   * default (email.send / sms.send / whatsapp.send / outbound_call),
   * but flips to `whatsapp.send_template` when a WhatsApp step
   * references a template registered in workspace settings.
   */
  actionType: string;
  /**
   * Channel-specific payload fields. Spread into the approval's
   * proposed_payload so the executor branches see the same shape
   * they'd see for a chat-driven send (no executor changes needed).
   */
  payload: Record<string, unknown>;
}

/**
 * Resolve a workflow step + recipient context into a ready-to-dispatch
 * approval payload. Handles four cases per channel:
 *
 *   email + templateRef       → look up email_templates[name],
 *                                render subject + body, payload =
 *                                { to: [contact.email], subject, body,
 *                                  contactId, rationale }
 *   email + bodyOverride      → render subject_override + body_override,
 *                                same payload shape
 *   sms + templateRef         → look up sms_templates[name], render body,
 *                                payload = { to: contact.phone, body,
 *                                            contactId, rationale }
 *   sms + bodyOverride        → render body_override, same payload
 *   whatsapp + templateRef    → look up whatsapp_templates[name] (Twilio
 *                                Content Template by HX SID); flip
 *                                actionType to whatsapp.send_template,
 *                                resolve contentVariables by position,
 *                                payload = { to, contentSid,
 *                                            contentVariables,
 *                                            templateName, contactId,
 *                                            rationale }
 *   whatsapp + bodyOverride   → freeform whatsapp.send (only works in
 *                                the 24h window — operator's call)
 *   voice + templateRef       → look up call_templates[name], render
 *                                aiInstructions, aiMode=true, payload =
 *                                { contactId, orgId, toNumber,
 *                                  aiMode: true, aiInstructions, rationale }
 *   voice + bodyOverride      → bodyOverride becomes aiInstructions
 *                                directly, same outer shape
 *
 * Throws on misconfiguration so dispatch can fail loud and the
 * workflow advances past a broken step rather than retrying forever.
 */
async function resolveStepPayload(
  deps: EnrollmentActivitiesDeps,
  input: {
    tenantId: string;
    contactId: string;
    step: WorkflowStepRow;
    channelActionType: string;
  },
): Promise<ResolvedStepPayload> {
  const { tenantId, contactId, step, channelActionType } = input;

  // Workspace settings (template registries). Bail loud if missing —
  // a step with a templateRef can't dispatch without them.
  const settings = await deps.workspaces.getSettings(deps.db, tenantId);

  // Contact + linked org for variable resolution.
  const contact = await withTenant(deps.db, tenantId, async (tx) =>
    deps.contacts.findById(tx, contactId),
  );
  if (!contact) {
    throw new Error(`contact ${contactId} not found`);
  }
  const org = contact.orgId
    ? await withTenant(deps.db, tenantId, async (tx) =>
        deps.organizations.findById(tx, contact.orgId!),
      )
    : null;

  const vars = buildVariableMap(contact, org?.legalName ?? null);
  const rationale = `campaign_enrollment_workflow step ${step.position}`;

  switch (step.channel) {
    case "email": {
      const recipientEmail = (contact.emails ?? [])[0];
      if (!recipientEmail) {
        throw new Error(`contact ${contactId} has no email on file`);
      }
      const { subject, body } = resolveEmailContent(step, settings, vars);
      return {
        actionType: channelActionType,
        payload: {
          to: [recipientEmail],
          subject,
          body,
          contactId: contact.id,
          rationale,
        },
      };
    }

    case "sms": {
      const recipientPhone = (contact.phones ?? [])[0];
      if (!recipientPhone) {
        throw new Error(`contact ${contactId} has no phone on file`);
      }
      const body = resolveBody(step, settings?.sms_templates, vars, "sms");
      return {
        actionType: channelActionType,
        payload: {
          to: recipientPhone,
          body,
          contactId: contact.id,
          rationale,
        },
      };
    }

    case "whatsapp": {
      const recipientPhone = (contact.phones ?? [])[0];
      if (!recipientPhone) {
        throw new Error(`contact ${contactId} has no phone on file`);
      }
      // Templated WhatsApp → Content Template send (cold-outreach path).
      if (step.templateRef) {
        const tmpl = (settings?.whatsapp_templates ?? []).find(
          (t) => t.name === step.templateRef,
        );
        if (!tmpl) {
          throw new Error(
            `whatsapp template "${step.templateRef}" not registered`,
          );
        }
        const contentVariables: Record<string, string> = {};
        const declared = tmpl.variables ?? [];
        for (let i = 0; i < declared.length; i++) {
          const varName = declared[i]!;
          const value = vars[varName];
          if (value === undefined) {
            throw new Error(
              `whatsapp template "${tmpl.name}" variable {{${i + 1}}} (${varName}) not resolvable from contact context`,
            );
          }
          contentVariables[String(i + 1)] = value;
        }
        return {
          actionType: "whatsapp.send_template",
          payload: {
            to: recipientPhone,
            contentSid: tmpl.contentSid,
            contentVariables,
            templateName: tmpl.name,
            contactId: contact.id,
            rationale,
          },
        };
      }
      // Untemplated WhatsApp (freeform) — only succeeds when the
      // recipient is in the 24h window. Operator's responsibility to
      // sequence inbound first.
      const body = resolveBody(step, undefined, vars, "whatsapp");
      return {
        actionType: channelActionType,
        payload: {
          to: recipientPhone,
          body,
          contactId: contact.id,
          rationale,
        },
      };
    }

    case "voice": {
      const recipientPhone = (contact.phones ?? [])[0];
      if (!recipientPhone) {
        throw new Error(`contact ${contactId} has no phone on file`);
      }
      if (!contact.orgId) {
        throw new Error(
          `contact ${contactId} has no org link — outbound_call requires orgId`,
        );
      }
      const aiInstructions = resolveAiInstructions(step, settings, vars);
      return {
        actionType: channelActionType,
        payload: {
          contactId: contact.id,
          orgId: contact.orgId,
          toNumber: recipientPhone,
          aiMode: true,
          ...(aiInstructions ? { aiInstructions } : {}),
          rationale,
        },
      };
    }

    default:
      throw new Error(`unsupported workflow channel: ${step.channel}`);
  }
}

/** Email = (subject, body), either from a registered template or the override pair. */
function resolveEmailContent(
  step: WorkflowStepRow,
  settings: WorkspaceSettings | null,
  vars: Record<string, string>,
): { subject: string; body: string } {
  if (step.templateRef) {
    const tmpl = (settings?.email_templates ?? []).find(
      (t) => t.name === step.templateRef,
    );
    if (!tmpl) {
      throw new Error(`email template "${step.templateRef}" not registered`);
    }
    return {
      subject: substituteTemplate(tmpl.subject, vars),
      body: substituteTemplate(tmpl.body, vars),
    };
  }
  if (!step.subjectOverride || !step.bodyOverride) {
    throw new Error(
      "email step is missing both templateRef and (subjectOverride + bodyOverride)",
    );
  }
  return {
    subject: substituteTemplate(step.subjectOverride, vars),
    body: substituteTemplate(step.bodyOverride, vars),
  };
}

/** SMS / WhatsApp freeform / Voice fallback — body-only resolution. */
function resolveBody(
  step: WorkflowStepRow,
  registry:
    | ReadonlyArray<{ name: string; body: string }>
    | undefined,
  vars: Record<string, string>,
  kind: string,
): string {
  if (step.templateRef) {
    const tmpl = (registry ?? []).find((t) => t.name === step.templateRef);
    if (!tmpl) {
      throw new Error(`${kind} template "${step.templateRef}" not registered`);
    }
    return substituteTemplate(tmpl.body, vars);
  }
  if (!step.bodyOverride) {
    throw new Error(
      `${kind} step is missing both templateRef and bodyOverride`,
    );
  }
  return substituteTemplate(step.bodyOverride, vars);
}

/** Voice = aiInstructions, either from call_templates or directly from bodyOverride. */
function resolveAiInstructions(
  step: WorkflowStepRow,
  settings: WorkspaceSettings | null,
  vars: Record<string, string>,
): string {
  if (step.templateRef) {
    const tmpl = (settings?.call_templates ?? []).find(
      (t) => t.name === step.templateRef,
    );
    if (!tmpl) {
      throw new Error(`call template "${step.templateRef}" not registered`);
    }
    return substituteTemplate(tmpl.aiInstructions, vars);
  }
  if (!step.bodyOverride) {
    throw new Error(
      "voice step is missing both templateRef and bodyOverride",
    );
  }
  return substituteTemplate(step.bodyOverride, vars);
}

/**
 * Standard variable bindings available in every workflow step, derived
 * from the recipient + their primary org. Operators writing templates
 * for use in workflows should stick to these names — chat-time evidence
 * (deal refs, recent touchpoints, free-form context) isn't accessible
 * from a Temporal activity, by design.
 */
function buildVariableMap(
  contact: Contact,
  orgLegalName: string | null,
): Record<string, string> {
  const fullName = contact.fullName ?? "";
  const firstName = fullName.split(/\s+/)[0] ?? "";
  const map: Record<string, string> = {
    recipient_name: firstName || fullName,
    recipient_full_name: fullName,
  };
  const email = (contact.emails ?? [])[0];
  if (email) map["recipient_email"] = email;
  const phone = (contact.phones ?? [])[0];
  if (phone) map["recipient_phone"] = phone;
  if (orgLegalName) map["org_name"] = orgLegalName;
  return map;
}
