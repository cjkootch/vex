import {
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from "@nestjs/common";
import type { Client as TemporalClient } from "@temporalio/client";
import {
  withTenant,
  type ActivityRepository,
  type AgentRunRepository,
  type ApprovalRepository,
  type ContactRepository,
  type Db,
  type EventRepository,
  type SummaryRepository,
  type WorkspaceRepository,
} from "@vex/db";
import {
  WorkflowId,
  mintVoiceAccessToken,
  type S3Uploader,
  type TwilioClient,
} from "@vex/integrations";
import type { VoiceSdkConfig } from "./calls.module.js";
import {
  CALLS_ACTIVITIES_REPO,
  CALLS_AGENT_RUNS_REPO,
  CALLS_APPROVALS_REPO,
  CALLS_CONTACTS_REPO,
  CALLS_DB_CLIENT,
  CALLS_EVENTS_REPO,
  CALLS_S3_UPLOADER,
  CALLS_SUMMARIES_REPO,
  CALLS_TASK_QUEUE,
  CALLS_TEMPORAL_CLIENT,
  CALLS_TWILIO_CLIENT,
  CALLS_VOICE_SDK_CONFIG,
  CALLS_WORKSPACES_REPO,
} from "./tokens.js";

/**
 * The workspace setting `enabled_agents` must contain this string for
 * any outbound call to be permitted. T3 is off by default — operators
 * opt in explicitly.
 */
export const OUTBOUND_CALL_AGENT_NAME = "outbound_call";

export interface InitiateCallArgs {
  tenantId: string;
  workspaceId: string;
  contactId: string;
  initiatedByUserId: string;
}

export interface InitiateCallResult {
  workflowId: string;
  approvalId: string;
  status: "pending_approval";
}

export interface CallStatusResult {
  workflowId: string;
  approval: {
    id: string;
    decision: string;
  };
  activity: {
    id: string;
    callSid: string;
    status: string;
    durationSeconds: number | null;
    transcriptRef: string | null;
    /**
     * When the activity was created — for an active call this is the
     * call start. Clients use it to compute a live duration counter
     * (now - startedAt) while the durationSeconds column is still null.
     */
    startedAt: string;
  } | null;
  /**
   * Best-effort contact display — the approval's proposed_payload
   * carries a contact_id; we resolve to full_name + primary phone so
   * the detail UI can show who the agent called without a second round
   * trip. null when the contact was deleted or the payload lacks an id.
   */
  callee: {
    id: string;
    fullName: string | null;
    phone: string | null;
  } | null;
  /** Temporal's view, when the workflow hasn't finished. */
  workflow?: { status: string };
}

@Injectable()
export class CallsService {
  private readonly log = new Logger(CallsService.name);

  constructor(
    @Inject(CALLS_DB_CLIENT) private readonly db: Db,
    @Inject(CALLS_WORKSPACES_REPO) private readonly workspaces: WorkspaceRepository,
    @Inject(CALLS_CONTACTS_REPO) private readonly contacts: ContactRepository,
    @Inject(CALLS_AGENT_RUNS_REPO) private readonly agentRuns: AgentRunRepository,
    @Inject(CALLS_APPROVALS_REPO) private readonly approvals: ApprovalRepository,
    @Inject(CALLS_ACTIVITIES_REPO) private readonly activities: ActivityRepository,
    @Inject(CALLS_SUMMARIES_REPO) private readonly summaries: SummaryRepository,
    @Inject(CALLS_EVENTS_REPO) private readonly events: EventRepository,
    @Inject(CALLS_TEMPORAL_CLIENT) private readonly temporal: TemporalClient,
    @Inject(CALLS_TWILIO_CLIENT) private readonly twilio: TwilioClient,
    @Inject(CALLS_S3_UPLOADER) private readonly s3: S3Uploader,
    @Inject(CALLS_TASK_QUEUE) private readonly taskQueue: string,
    @Inject(CALLS_VOICE_SDK_CONFIG) private readonly voiceSdk: VoiceSdkConfig,
  ) {}

  /**
   * Start an outbound-call workflow. Does synchronous pre-flight gates
   * (T3 enabled, contact exists with a phone, enabled_agents membership)
   * so the caller gets early HTTP rejections. The workflow re-runs the
   * window + suppression checks as defense in depth.
   *
   * Creates the approval row here (not inside the workflow) so the HTTP
   * response can carry approval_id. The workflow's createApprovalRow
   * activity is idempotent — it resolves the row by workflow_id and
   * returns its existing id.
   */
  async initiateCall(args: InitiateCallArgs): Promise<InitiateCallResult> {
    const workspace = await this.workspaces.findById(this.db, args.workspaceId);
    if (!workspace) throw new NotFoundException(`workspace not found`);
    if (!workspace.settings.enabled_agents.includes(OUTBOUND_CALL_AGENT_NAME)) {
      throw new ForbiddenException(
        `outbound_call is disabled for this workspace; enable it in settings.enabled_agents`,
      );
    }

    return withTenant(this.db, args.tenantId, async (tx) => {
      const contact = await this.contacts.findById(tx, args.contactId);
      if (!contact) throw new NotFoundException(`contact ${args.contactId} not found`);
      const phone = (contact.phones ?? []).find((p) => typeof p === "string" && p.length > 0);
      if (!phone) {
        throw new BadRequestException(`contact ${args.contactId} has no phone number on file`);
      }

      const agentRun = await this.agentRuns.create(tx, args.tenantId, {
        agentName: OUTBOUND_CALL_AGENT_NAME,
        inputRefs: {
          contact_id: args.contactId,
          org_id: contact.orgId,
          initiated_by: args.initiatedByUserId,
          to_number: phone,
        },
      });
      const workflowId = WorkflowId.outboundCall(agentRun.id);

      const approval = await this.approvals.create(tx, args.tenantId, {
        agentRunId: agentRun.id,
        actionType: "outbound_call",
        proposedPayload: {
          tier: "T3",
          workflow_id: workflowId,
          contact_id: args.contactId,
          org_id: contact.orgId,
          to_number: phone,
          initiated_by: args.initiatedByUserId,
        },
      });

      await this.temporal.workflow.start("outboundCallWorkflow", {
        taskQueue: this.taskQueue,
        workflowId,
        args: [
          {
            tenantId: args.tenantId,
            workspaceId: args.workspaceId,
            contactId: args.contactId,
            orgId: contact.orgId,
            toNumber: phone,
            agentRunId: agentRun.id,
            initiatedByUserId: args.initiatedByUserId,
          },
        ],
      });

      await this.events.insertIfNotExists(tx, args.tenantId, {
        verb: "call.initiated",
        subjectType: "agent_run",
        subjectId: agentRun.id,
        actorType: "user",
        actorId: args.initiatedByUserId,
        objectType: "contact",
        objectId: args.contactId,
        occurredAt: new Date(),
        idempotencyKey: `call.initiated:${workflowId}`,
        metadata: {
          workflow_id: workflowId,
          approval_id: approval.id,
          to_number: phone,
        },
      });

      this.log.log(`call initiated: workflow=${workflowId} approval=${approval.id}`);
      return {
        workflowId,
        approvalId: approval.id,
        status: "pending_approval",
      };
    });
  }

  async getStatus(tenantId: string, workflowId: string): Promise<CallStatusResult> {
    return withTenant(this.db, tenantId, async (tx) => {
      const approval = await this.approvals.findByWorkflowId(tx, workflowId);
      if (!approval) throw new NotFoundException(`call ${workflowId} not found`);
      const activity = await this.activities.findByTypeAndSessionId(
        tx,
        "voice_call",
        workflowId,
      );
      const activityOut = activity
        ? {
            id: activity.id,
            callSid:
              typeof activity.metadata["call_sid"] === "string"
                ? (activity.metadata["call_sid"] as string)
                : "",
            status:
              typeof activity.metadata["status"] === "string"
                ? (activity.metadata["status"] as string)
                : activity.result ?? "unknown",
            durationSeconds: activity.durationSeconds,
            transcriptRef: activity.transcriptRef,
            startedAt: activity.occurredAt.toISOString(),
          }
        : null;

      // Best-effort Temporal describe — surfaces "RUNNING" until the
      // workflow terminates. Not fatal when Temporal is unreachable;
      // the DB view is still returned.
      let workflowStatus: string | null = null;
      try {
        const handle = this.temporal.workflow.getHandle(workflowId);
        const desc = await handle.describe();
        workflowStatus = desc.status.name;
      } catch {
        workflowStatus = null;
      }

      // Callee resolution — the approval payload carries the contact_id
      // the operator selected at initiateCall time. Pull the name +
      // primary phone so the detail page has "who" at a glance.
      const payload = approval.proposedPayload as { contact_id?: string } | null;
      const contactId = payload?.contact_id ?? null;
      let callee: CallStatusResult["callee"] = null;
      if (contactId) {
        const contact = await this.contacts.findById(tx, contactId);
        callee = {
          id: contactId,
          fullName: contact?.fullName ?? null,
          phone: contact?.phones?.[0] ?? null,
        };
      }

      return {
        workflowId,
        approval: { id: approval.id, decision: approval.decision },
        activity: activityOut,
        callee,
        ...(workflowStatus ? { workflow: { status: workflowStatus } } : {}),
      };
    });
  }

  /**
   * Sprint I — mark a call as needing human backup. Creates a T2
   * approval with actionType `call.request_backup` that surfaces in
   * the operator inbox with a "Join call" CTA. The workflow + the
   * actual join behaviour (Twilio Conference + operator audio) lands
   * in Sprints J/K; today this is the observability rail.
   *
   * Idempotent at the action-type level — if an open backup request
   * already exists for this workflow, return it instead of minting
   * a duplicate. The operator sees one ping, not a spam cluster.
   */
  async requestHumanBackup(args: {
    tenantId: string;
    workflowId: string;
    reason?: string;
    initiatedBy?: string;
  }): Promise<{ approvalId: string; existed: boolean }> {
    return withTenant(this.db, args.tenantId, async (tx) => {
      const callApproval = await this.approvals.findByWorkflowId(tx, args.workflowId);
      if (!callApproval) {
        throw new NotFoundException(`call ${args.workflowId} not found`);
      }
      const activity = await this.activities.findByTypeAndSessionId(
        tx,
        "voice_call",
        args.workflowId,
      );
      const callSid =
        activity && typeof activity.metadata["call_sid"] === "string"
          ? (activity.metadata["call_sid"] as string)
          : null;
      const durationAtRequest = activity
        ? Math.max(
            0,
            Math.floor(
              (Date.now() - activity.occurredAt.getTime()) / 1000,
            ),
          )
        : 0;

      // Check for an existing open backup request for this call. The
      // workflow_id lookup handles the case; approvals.findByWorkflowId
      // returns the most-recent, so we specifically scan decision=pending.
      const pending = await this.approvals.listByDecision(tx, "pending", 100);
      const existing = pending.find((a) => {
        if (a.actionType !== "call.request_backup") return false;
        const p = a.proposedPayload as { workflow_id?: string } | null;
        return p?.workflow_id === args.workflowId;
      });
      if (existing) {
        return { approvalId: existing.id, existed: true };
      }

      const payload: {
        tier: "T2";
        workflow_id: string;
        call_sid: string | null;
        duration_at_request_seconds: number;
        callee_contact_id: string | null;
        reason: string | null;
        initiated_by: string | null;
      } = {
        tier: "T2",
        workflow_id: args.workflowId,
        call_sid: callSid,
        duration_at_request_seconds: durationAtRequest,
        callee_contact_id:
          (callApproval.proposedPayload as { contact_id?: string } | null)
            ?.contact_id ?? null,
        reason: args.reason ?? null,
        initiated_by: args.initiatedBy ?? null,
      };
      const approval = await this.approvals.create(tx, args.tenantId, {
        agentRunId: callApproval.agentRunId,
        actionType: "call.request_backup",
        proposedPayload: payload,
      });

      await this.events.insertIfNotExists(tx, args.tenantId, {
        verb: "call.backup_requested",
        subjectType: "approval",
        subjectId: approval.id,
        actorType: args.initiatedBy ? "user" : "system",
        actorId: args.initiatedBy ?? "outbound_call_workflow",
        objectType: "approval",
        objectId: approval.id,
        occurredAt: new Date(),
        idempotencyKey: `call.backup_requested:${approval.id}`,
        metadata: {
          workflow_id: args.workflowId,
          call_sid: callSid,
          duration_at_request_seconds: durationAtRequest,
          reason: args.reason ?? null,
        },
      });

      this.log.log(
        `backup requested for call ${args.workflowId} (approval=${approval.id})`,
      );
      return { approvalId: approval.id, existed: false };
    });
  }

  /**
   * Sprint J — mint a Twilio Voice SDK Access Token so the operator's
   * browser can join the conference room the callee leg is in. The
   * token carries a VoiceGrant scoped to the configured TwiML app;
   * `Device.connect({ conference })` causes Twilio to POST to that
   * app's Voice URL which should return `<Dial><Conference/>` for
   * the matching conference name.
   *
   * Validation:
   *   - env config present (503 otherwise)
   *   - the workflow is a real call in this tenant (404 otherwise)
   *   - the call isn't already in a terminal state (409 otherwise —
   *     no point joining a conference that has wound down)
   */
  async mintJoinToken(args: {
    tenantId: string;
    workflowId: string;
    userId: string;
    conferenceName: string;
  }): Promise<{
    token: string;
    identity: string;
    conferenceName: string;
    expiresAt: string;
  }> {
    if (!this.voiceSdk) {
      throw new ServiceUnavailableException(
        "twilio_voice_sdk_unconfigured: set TWILIO_API_KEY, TWILIO_API_SECRET, TWILIO_TWIML_APP_SID",
      );
    }
    return withTenant(this.db, args.tenantId, async (tx) => {
      const approval = await this.approvals.findByWorkflowId(tx, args.workflowId);
      if (!approval) throw new NotFoundException(`call ${args.workflowId} not found`);
      const activity = await this.activities.findByTypeAndSessionId(
        tx,
        "voice_call",
        args.workflowId,
      );
      if (activity && isTerminalCallStatus(activity)) {
        throw new BadRequestException("call_already_ended");
      }
      const minted = mintVoiceAccessToken(this.voiceSdk!, {
        identity: `operator-${args.userId}`,
        conferenceName: args.conferenceName,
      });
      this.log.log(
        `minted join token for workflow=${args.workflowId} user=${args.userId}`,
      );
      return {
        token: minted.token,
        identity: minted.identity,
        conferenceName: args.conferenceName,
        expiresAt: minted.expiresAt,
      };
    });
  }

  async getTranscript(
    tenantId: string,
    workflowId: string,
  ): Promise<{ transcript: string; summary: string | null }> {
    return withTenant(this.db, tenantId, async (tx) => {
      const activity = await this.activities.findByTypeAndSessionId(
        tx,
        "voice_call",
        workflowId,
      );
      if (!activity) throw new NotFoundException(`call ${workflowId} not found`);
      if (!activity.transcriptRef) {
        return { transcript: "", summary: null };
      }
      const transcript = await this.s3.getText(activity.transcriptRef);
      const summary = await this.summaries.getLatest(
        tx,
        "activity",
        activity.id,
        "call_summary",
      );
      return { transcript, summary: summary?.content ?? null };
    });
  }

  // -------------------------------------------------------------------
  // Twilio webhook handlers — called with workflowId + form params.
  // -------------------------------------------------------------------

  /**
   * Twilio status callback. Signals the waiting OutboundCallWorkflow.
   * Non-terminal transitions (`ringing`, `in-progress`) are also
   * forwarded — the workflow only acts on terminal values, but we
   * surface the full lifecycle for audit.
   */
  async handleStatusCallback(
    workflowId: string,
    params: Record<string, string>,
  ): Promise<void> {
    const callSid = params["CallSid"];
    const status = params["CallStatus"] as CallStatusPayloadName;
    if (!callSid || !status) {
      throw new BadRequestException("missing CallSid or CallStatus");
    }
    const durationRaw = params["CallDuration"];
    const durationSeconds = durationRaw
      ? Number.parseInt(durationRaw, 10)
      : undefined;
    const at = params["Timestamp"] ?? new Date().toISOString();

    const handle = this.temporal.workflow.getHandle(workflowId);
    try {
      await handle.signal("call.status.update", {
        callSid,
        status,
        ...(durationSeconds !== undefined && Number.isFinite(durationSeconds)
          ? { durationSeconds }
          : {}),
        at,
      });
    } catch (err) {
      this.log.warn(
        `call-status signal failed for ${workflowId}: ${(err as Error).message}`,
      );
    }
  }

  /**
   * Twilio recording callback. Downloads the MP3, uploads to S3 under
   * recordings/{tenant_id}/{call_sid}.mp3, and signals the workflow
   * with the storage key. Transcript text is left empty — Sprint 12
   * defers automated transcription; a follow-up sprint adds Whisper.
   */
  async handleRecordingCallback(
    tenantId: string,
    workflowId: string,
    params: Record<string, string>,
  ): Promise<void> {
    const recordingStatus = params["RecordingStatus"];
    if (recordingStatus && recordingStatus !== "completed") {
      this.log.log(`recording status=${recordingStatus} for ${workflowId}`);
      return;
    }
    const callSid = params["CallSid"];
    const recordingSid = params["RecordingSid"];
    const recordingUrl = params["RecordingUrl"];
    const durationRaw = params["RecordingDuration"];
    if (!callSid || !recordingSid || !recordingUrl) {
      throw new BadRequestException(
        "missing CallSid / RecordingSid / RecordingUrl",
      );
    }
    const durationSeconds = durationRaw
      ? Number.parseInt(durationRaw, 10)
      : 0;

    // Twilio serves both mp3 and wav; default is mp3.
    const audioUrl = recordingUrl.endsWith(".mp3")
      ? recordingUrl
      : `${recordingUrl}.mp3`;
    const audio = await this.twilio.downloadRecording(audioUrl);
    const storageKey = this.twilio.recordingStorageKey(tenantId, callSid);
    await this.s3.putBuffer(storageKey, audio, "audio/mpeg");

    const handle = this.temporal.workflow.getHandle(workflowId);
    try {
      await handle.signal("call.recording.available", {
        callSid,
        recordingSid,
        storageKey,
        durationSeconds,
      });
    } catch (err) {
      this.log.warn(
        `call-recording signal failed for ${workflowId}: ${(err as Error).message}`,
      );
    }
  }
}

/**
 * Terminal status set from the Twilio Voice lifecycle. We use the
 * activity metadata mirror the webhook writes into — the activities
 * table is the canonical "is the call still live" signal in apps/api.
 */
function isTerminalCallStatus(activity: { metadata: Record<string, unknown>; result: string | null }): boolean {
  const status =
    (typeof activity.metadata["status"] === "string"
      ? (activity.metadata["status"] as string)
      : activity.result) ?? "";
  return [
    "completed",
    "busy",
    "failed",
    "no-answer",
    "canceled",
  ].includes(status);
}

type CallStatusPayloadName =
  | "initiated"
  | "ringing"
  | "in-progress"
  | "answered"
  | "completed"
  | "busy"
  | "failed"
  | "no-answer"
  | "canceled";
