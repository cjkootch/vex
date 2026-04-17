import { ApplicationFailure } from "@temporalio/activity";
import { createId, TenantId, type EvidenceItem, type EvidencePack } from "@vex/domain";
import {
  TRANSCRIPT_ACTION_ITEMS_SYSTEM_PROMPT,
  TRANSCRIPT_SUMMARY_SYSTEM_PROMPT,
} from "@vex/agents";
import {
  withTenant,
  type ActivityRepository,
  type ApprovalRepository,
  type ContactRepository,
  type Db,
  type EventRepository,
  type SummaryRepository,
  type TouchpointRepository,
} from "@vex/db";
import type {
  AnthropicAdapter,
  S3Uploader,
  TwilioClient,
} from "@vex/integrations";
import { createLogger, withSpan } from "@vex/telemetry";

const log = createLogger("worker.call");

export interface CallActivitiesDeps {
  db: Db;
  contacts: ContactRepository;
  approvals: ApprovalRepository;
  activities: ActivityRepository;
  touchpoints: TouchpointRepository;
  summaries: SummaryRepository;
  events: EventRepository;
  twilio: TwilioClient;
  anthropic: AnthropicAdapter;
  s3: S3Uploader;
  /** Public URL pattern for the TwiML endpoint Twilio hits to drive the call. */
  twimlUrl: string;
  /** Public URL the Twilio status-callback webhook will POST to. */
  statusCallbackUrl: string;
  /** Public URL the recording-status-callback webhook will POST to. */
  recordingCallbackUrl: string;
}

// ---------------------------------------------------------------------------
// Input / output types for each activity
// ---------------------------------------------------------------------------

export interface CheckCallWindowInput {
  tenantId: string;
  contactId: string;
}

export interface CheckCallWindowResult {
  allowed: boolean;
  reason?: string;
  contactTimezone: string;
  /** Local hour we evaluated against (24h, contact-local). */
  localHour: number;
}

export interface CheckSuppressionInput {
  tenantId: string;
  contactId: string;
}

export interface CheckSuppressionResult {
  suppressed: boolean;
  reason?: string;
  optOutAt?: string;
}

export interface CreateApprovalRowInput {
  tenantId: string;
  agentRunId: string;
  workflowId: string;
  contactId: string;
  orgId: string;
  toNumber: string;
  initiatedByUserId: string;
}

export interface CreateApprovalRowResult {
  approvalId: string;
}

export interface CreateTwilioCallInput {
  tenantId: string;
  contactId: string;
  orgId: string;
  workflowId: string;
  agentRunId: string;
  toNumber: string;
  approvalId: string;
}

export interface CreateTwilioCallResult {
  callSid: string;
  status: string;
  activityId: string;
}

export interface FetchAndStoreRecordingInput {
  tenantId: string;
  callSid: string;
  recordingSid: string;
  recordingUrl: string;
  durationSeconds: number;
  contactId: string;
  orgId: string;
  agentRunId: string;
}

export interface FetchAndStoreRecordingResult {
  storageKey: string;
  activityId: string;
}

export interface ProcessTranscriptInput {
  tenantId: string;
  workspaceId: string;
  activityId: string;
  callSid: string;
  transcriptText: string;
  durationSeconds: number;
  orgId: string;
  contactId: string;
}

export interface ProcessTranscriptResult {
  summaryId: string;
  touchpointId: string;
  actionItemApprovalIds: string[];
  costUsd: number;
}

export interface EmitAuditEventInput {
  tenantId: string;
  verb: string;
  subjectType: string;
  subjectId: string;
  metadata?: Record<string, unknown>;
  /** Idempotency key — workflow passes a stable value so retries don't dupe. */
  idempotencyKey: string;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const CALL_WINDOW_START_HOUR = 8;
const CALL_WINDOW_END_HOUR = 18;
const DEFAULT_TIMEZONE = "UTC";

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Build the activity bundle the Temporal Worker exposes to the
 * OutboundCallWorkflow. Every activity is idempotent — Temporal retries
 * under the hood when a worker dies between "ran" and "recorded", and
 * the guardrail activities (call window, suppression) have no side
 * effects at all. Side-effect activities (approval row, Twilio call,
 * recording store, transcript processing) use stable keys from the
 * workflow input to dedupe.
 */
export function buildCallActivities(deps: CallActivitiesDeps) {
  return {
    /**
     * Reject the call if the contact's local time is outside 08:00-18:00.
     * Pure read, no side effects.
     */
    async checkCallWindow(
      input: CheckCallWindowInput,
    ): Promise<CheckCallWindowResult> {
      return withSpan(
        "temporal.activity.checkCallWindow",
        { tenant_id: input.tenantId, contact_id: input.contactId },
        async () => {
          const contact = await withTenant(
            deps.db,
            input.tenantId,
            (tx) => deps.contacts.findById(tx, input.contactId),
          );
          if (!contact) {
            throw ApplicationFailure.nonRetryable(
              `contact ${input.contactId} not found`,
              "CONTACT_NOT_FOUND",
            );
          }
          const tz = contact.timezone ?? DEFAULT_TIMEZONE;
          const localHour = localHourIn(tz, new Date());
          const inWindow =
            localHour >= CALL_WINDOW_START_HOUR &&
            localHour < CALL_WINDOW_END_HOUR;
          return {
            allowed: inWindow,
            contactTimezone: tz,
            localHour,
            ...(inWindow
              ? {}
              : {
                  reason: `contact local time ${localHour}:00 (${tz}) is outside ${CALL_WINDOW_START_HOUR}:00-${CALL_WINDOW_END_HOUR}:00 window`,
                }),
          };
        },
      );
    },

    /**
     * Refuse to dial a contact that has opted out. Pure read — no side
     * effects so retries are safe.
     */
    async checkSuppression(
      input: CheckSuppressionInput,
    ): Promise<CheckSuppressionResult> {
      return withSpan(
        "temporal.activity.checkSuppression",
        { tenant_id: input.tenantId, contact_id: input.contactId },
        async () => {
          const contact = await withTenant(
            deps.db,
            input.tenantId,
            (tx) => deps.contacts.findById(tx, input.contactId),
          );
          if (!contact) {
            throw ApplicationFailure.nonRetryable(
              `contact ${input.contactId} not found`,
              "CONTACT_NOT_FOUND",
            );
          }
          if (contact.optOutAt) {
            return {
              suppressed: true,
              reason:
                contact.optOutReason ?? "Contact has opted out of outreach.",
              optOutAt: contact.optOutAt.toISOString(),
            };
          }
          return { suppressed: false };
        },
      );
    },

    /**
     * Create the T3 approval row that gates the call. Idempotent via
     * the workflowId — if a row with this workflow already exists we
     * return it instead of inserting a second.
     */
    async createApprovalRow(
      input: CreateApprovalRowInput,
    ): Promise<CreateApprovalRowResult> {
      return withSpan(
        "temporal.activity.createApprovalRow",
        { tenant_id: input.tenantId, workflow_id: input.workflowId },
        async () => {
          return withTenant(deps.db, input.tenantId, async (tx) => {
            // Idempotency check — a retried activity must surface the
            // same approvalId so the workflow's signal-wait key stays
            // stable across worker restarts.
            const existing = await deps.approvals.findByWorkflowId(
              tx,
              input.workflowId,
            );
            if (existing) return { approvalId: existing.id };

            const approval = await deps.approvals.create(
              tx,
              input.tenantId,
              {
                agentRunId: input.agentRunId,
                actionType: "outbound_call",
                proposedPayload: {
                  tier: "T3",
                  workflow_id: input.workflowId,
                  contact_id: input.contactId,
                  org_id: input.orgId,
                  to_number: input.toNumber,
                  initiated_by: input.initiatedByUserId,
                },
              },
            );
            log.info("call approval created", {
              approval_id: approval.id,
              workflow_id: input.workflowId,
            });
            return { approvalId: approval.id };
          });
        },
      );
    },

    /**
     * Actually dial the number. Runs ONLY after the approval signal
     * has been received — the workflow is the single gate. Idempotent:
     * we write the activity row first with external_key=workflowId so
     * a retry that survives past the Twilio insert is recognised.
     */
    async createTwilioCall(
      input: CreateTwilioCallInput,
    ): Promise<CreateTwilioCallResult> {
      return withSpan(
        "temporal.activity.createTwilioCall",
        { tenant_id: input.tenantId, workflow_id: input.workflowId },
        async () => {
          // Idempotency — if a `voice_call` activity already carries
          // this workflow_id we return its stored callSid rather than
          // dial the number a second time.
          const existing = await withTenant(
            deps.db,
            input.tenantId,
            (tx) =>
              deps.activities.findByTypeAndSessionId(
                tx,
                "voice_call",
                input.workflowId,
              ),
          );
          if (existing) {
            const priorSid =
              typeof existing.metadata["call_sid"] === "string"
                ? (existing.metadata["call_sid"] as string)
                : "";
            const priorStatus =
              typeof existing.metadata["status"] === "string"
                ? (existing.metadata["status"] as string)
                : "in-progress";
            return {
              callSid: priorSid,
              status: priorStatus,
              activityId: existing.id,
            };
          }

          const { callSid, status } = await deps.twilio.createOutboundCall({
            to: input.toNumber,
            twimlUrl: withWorkflowId(deps.twimlUrl, input.workflowId),
            statusCallback: withWorkflowId(
              deps.statusCallbackUrl,
              input.workflowId,
            ),
            recordingStatusCallback: withWorkflowId(
              deps.recordingCallbackUrl,
              input.workflowId,
            ),
            record: true,
            timeout: 30,
          });

          const activity = await withTenant(
            deps.db,
            input.tenantId,
            (tx) =>
              deps.activities.insert(tx, input.tenantId, {
                type: "voice_call",
                occurredAt: new Date(),
                result: "initiated",
                relatedObjectIds: {
                  contact_id: input.contactId,
                  org_id: input.orgId,
                  approval_id: input.approvalId,
                },
                metadata: {
                  session_id: input.workflowId,
                  call_sid: callSid,
                  status,
                  workflow_id: input.workflowId,
                  agent_run_id: input.agentRunId,
                  direction: "outbound",
                },
              }),
          );
          log.info("twilio call created", {
            call_sid: callSid,
            workflow_id: input.workflowId,
            activity_id: activity.id,
          });
          return { callSid, status, activityId: activity.id };
        },
      );
    },

    /**
     * Download the recording from Twilio, upload to our S3, update the
     * `voice_call` activity's `transcript_ref` to the S3 key. Audio
     * bytes never persist in a DB column — only the storage key.
     */
    async fetchAndStoreRecording(
      input: FetchAndStoreRecordingInput,
    ): Promise<FetchAndStoreRecordingResult> {
      return withSpan(
        "temporal.activity.fetchAndStoreRecording",
        { tenant_id: input.tenantId, call_sid: input.callSid },
        async () => {
          const audio = await deps.twilio.downloadRecording(
            input.recordingUrl,
          );
          const storageKey = deps.twilio.recordingStorageKey(
            input.tenantId,
            input.callSid,
          );
          await deps.s3.putBuffer(storageKey, audio, "audio/mpeg");

          const activity = await withTenant(
            deps.db,
            input.tenantId,
            async (tx) => {
              const existing =
                await deps.activities.findByTypeAndSessionId(
                  tx,
                  "voice_call",
                  (input as FetchAndStoreRecordingInput & {
                    workflowId?: string;
                  }).workflowId ?? input.callSid,
                );
              if (existing) {
                return deps.activities.updateTranscriptRef(
                  tx,
                  existing.id,
                  storageKey,
                  {
                    recording_sid: input.recordingSid,
                    duration_seconds: input.durationSeconds,
                  },
                );
              }
              return deps.activities.insert(tx, input.tenantId, {
                type: "voice_call",
                occurredAt: new Date(),
                result: "recorded",
                transcriptRef: storageKey,
                durationSeconds: input.durationSeconds,
                relatedObjectIds: {
                  contact_id: input.contactId,
                  org_id: input.orgId,
                },
                metadata: {
                  session_id: input.callSid,
                  call_sid: input.callSid,
                  recording_sid: input.recordingSid,
                  duration_seconds: input.durationSeconds,
                  agent_run_id: input.agentRunId,
                },
              });
            },
          );
          return { storageKey, activityId: activity.id };
        },
      );
    },

    /**
     * Transcribe + summarize + extract action items. Mirrors the
     * Sprint 9 TranscriptProcessor flow without the BullMQ harness —
     * both end up writing the same rows so downstream consumers
     * (approval inbox, autonomy feed) don't have to distinguish
     * browser voice from PSTN.
     *
     * Idempotency: the activity reads the Activity row and skips work
     * when a linked summary already exists.
     */
    async processTranscript(
      input: ProcessTranscriptInput,
    ): Promise<ProcessTranscriptResult> {
      return withSpan(
        "temporal.activity.processTranscript",
        { tenant_id: input.tenantId, activity_id: input.activityId },
        async () => {
          return withTenant(deps.db, input.tenantId, async (tx) => {
            const priorSummary = await deps.summaries.getLatest(
              tx,
              "activity",
              input.activityId,
              "call_summary",
            );
            if (priorSummary) {
              log.info("transcript already processed — idempotent skip", {
                activity_id: input.activityId,
                summary_id: priorSummary.id,
              });
              return {
                summaryId: priorSummary.id,
                touchpointId: "",
                actionItemApprovalIds: [],
                costUsd: 0,
              };
            }

            const pack = transcriptEvidence(
              input.callSid,
              input.transcriptText,
              input.durationSeconds,
            );

            // Summary
            const summaryResult = await deps.anthropic.query({
              tenantId: TenantId(input.tenantId),
              idempotencyKey: `call_summary:${input.activityId}`,
              systemPrompt: TRANSCRIPT_SUMMARY_SYSTEM_PROMPT,
              evidencePack: pack,
              userMessage:
                "Summarize this call in two short paragraphs. Lead with the decision or next step.",
              maxTokens: 600,
            });

            const summary = await deps.summaries.upsert(
              tx,
              input.tenantId,
              {
                subjectType: "activity",
                subjectId: input.activityId,
                summaryType: "call_summary",
                content: summaryResult.answer,
              },
            );

            // Touchpoint — so the contact / org timeline has the call.
            const touchpoint = await deps.touchpoints.insert(
              tx,
              input.tenantId,
              {
                channel: "voice",
                actor: "agent.outbound_call",
                occurredAt: new Date(),
                contactId: input.contactId,
                orgId: input.orgId,
                metadata: {
                  call_sid: input.callSid,
                  activity_id: input.activityId,
                  summary_id: summary.id,
                  duration_seconds: input.durationSeconds,
                },
              },
            );

            // Action items (T2 approvals)
            const actionItemsResult = await deps.anthropic.query({
              tenantId: TenantId(input.tenantId),
              idempotencyKey: `call_action_items:${input.activityId}`,
              systemPrompt: TRANSCRIPT_ACTION_ITEMS_SYSTEM_PROMPT,
              evidencePack: pack,
              userMessage:
                "List explicit commitments made on this call as discrete action items.",
              maxTokens: 800,
            });

            const actionApprovalIds: string[] = [];
            for (const action of actionItemsResult.proposedActions) {
              if (action.tier !== "T2") continue;
              const approval = await deps.approvals.create(
                tx,
                input.tenantId,
                {
                  actionType: "voice_followup",
                  proposedPayload: {
                    ...action.payload,
                    tier: action.tier,
                    rationale: action.rationale,
                    source_activity_id: input.activityId,
                    source_call_sid: input.callSid,
                  },
                },
              );
              actionApprovalIds.push(approval.id);
            }

            await deps.events.insertIfNotExists(tx, input.tenantId, {
              verb: "call.transcript.processed",
              subjectType: "activity",
              subjectId: input.activityId,
              actorType: "system",
              actorId: "outbound_call_workflow",
              objectType: "activity",
              objectId: input.activityId,
              occurredAt: new Date(),
              idempotencyKey: `call.transcript.processed:${input.activityId}`,
              metadata: {
                call_sid: input.callSid,
                summary_id: summary.id,
                touchpoint_id: touchpoint.id,
                action_item_approvals: actionApprovalIds.length,
                audit_event_id: createId(),
              },
            });

            return {
              summaryId: summary.id,
              touchpointId: touchpoint.id,
              actionItemApprovalIds: actionApprovalIds,
              costUsd: summaryResult.costUsd + actionItemsResult.costUsd,
            };
          });
        },
      );
    },

    /**
     * Write an audit event row. Terminal step in every workflow branch —
     * ensures the timeline records rejection, expiry, and completion
     * equally. Idempotent via the caller-supplied key.
     */
    async emitAuditEvent(input: EmitAuditEventInput): Promise<void> {
      await withTenant(deps.db, input.tenantId, async (tx) => {
        await deps.events.insertIfNotExists(tx, input.tenantId, {
          verb: input.verb,
          subjectType: input.subjectType,
          subjectId: input.subjectId,
          actorType: "system",
          actorId: "outbound_call_workflow",
          objectType: input.subjectType,
          objectId: input.subjectId,
          occurredAt: new Date(),
          idempotencyKey: input.idempotencyKey,
          metadata: {
            ...(input.metadata ?? {}),
            audit_event_id: createId(),
          },
        });
      });
    },
  };
}

export type CallActivities = ReturnType<typeof buildCallActivities>;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Return the hour-of-day (0-23) in `timezone` for the given instant.
 * Uses Intl.DateTimeFormat — a valid IANA timezone string is required;
 * unrecognised zones fall back to the original UTC hour.
 */
function localHourIn(timezone: string, at: Date): number {
  try {
    const formatter = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      hour: "2-digit",
      hour12: false,
    });
    const parts = formatter.formatToParts(at);
    const hourStr = parts.find((p) => p.type === "hour")?.value ?? "0";
    const n = Number.parseInt(hourStr, 10);
    return Number.isFinite(n) ? n % 24 : at.getUTCHours();
  } catch {
    return at.getUTCHours();
  }
}

/** Append `?wf=<workflow-id>` so the Twilio webhook can route signals. */
function withWorkflowId(baseUrl: string, workflowId: string): string {
  const joinChar = baseUrl.includes("?") ? "&" : "?";
  return `${baseUrl}${joinChar}wf=${encodeURIComponent(workflowId)}`;
}

/** Minimal evidence pack wrapping a call transcript for the summary prompt. */
function transcriptEvidence(
  callSid: string,
  text: string,
  durationSeconds: number,
): EvidencePack {
  const item: EvidenceItem = {
    chunk_id: callSid,
    object_type: "activity",
    object_id: callSid,
    chunk_text: text,
    source_ref: `call ${callSid}`,
    source_type: "event",
    occurred_at: new Date(),
    freshness_hours: 0,
    confidence_score: 1,
    corroborated_by_count: 0,
    permission_scope: "workspace",
    raw_event_ref: null,
    summary_version: null,
  };
  return {
    summaries: [],
    items: [item],
    estimated_tokens: Math.ceil(text.length / 4) + 60,
  };
}
