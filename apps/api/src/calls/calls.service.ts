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
import type { Redis } from "ioredis";
import {
  schema,
  withTenant,
  type ActivityRepository,
  type AgentRunRepository,
  type ApprovalRepository,
  type ContactRepository,
  type Db,
  type EventRepository,
  type SummaryRepository,
  type TouchpointRepository,
  type WorkspaceRepository,
} from "@vex/db";
import { and, desc, eq, or, sql } from "drizzle-orm";
import {
  WorkflowId,
  mintVoiceAccessToken,
  type S3Uploader,
  type SlackNotifier,
  type TwilioClient,
} from "@vex/integrations";
import type { ResendClient, VoiceSdkConfig } from "./calls.module.js";
import {
  CALLS_ACTIVITIES_REPO,
  CALLS_AGENT_RUNS_REPO,
  CALLS_APP_BASE_URL,
  CALLS_APPROVALS_REPO,
  CALLS_CONTACTS_REPO,
  CALLS_DB_CLIENT,
  CALLS_EVENTS_REPO,
  CALLS_REDIS_CLIENT,
  CALLS_RESEND_CLIENT,
  CALLS_S3_UPLOADER,
  CALLS_SLACK_NOTIFIER,
  CALLS_SUMMARIES_REPO,
  CALLS_TASK_QUEUE,
  CALLS_TOUCHPOINTS_REPO,
  CALLS_TEMPORAL_CLIENT,
  CALLS_TWILIO_CLIENT,
  CALLS_VOICE_SDK_CONFIG,
  CALLS_WORKSPACES_REPO,
} from "./tokens.js";

const DEFAULT_DEMO_SCRIPT =
  "Hi, this is Vex calling on behalf of Vector Trade Capital. " +
  "We received your inquiry on our website about fuel trading services. " +
  "I wanted to follow up to learn a bit about your volume requirements " +
  "and the product grades you're interested in. " +
  "Do you have a minute to chat?";

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
    /**
     * Whether a playable recording exists for this activity. True
     * when the row carries either a Twilio recording URL on
     * `metadata.recording_url` (legacy demo path) or an S3 storage
     * key on `transcript_ref` (the prod path stamps the recording's
     * `recordings/{tenant}/{call_sid}.mp3` key there). The detail UI
     * gates an `<audio>` player on this flag and points it at
     * `/api/calls/activities/:id/recording`.
     */
    hasRecording: boolean;
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

  /**
   * Short-lived store of custom AI conversation scenarios keyed by
   * workflow id (`demo-<timestamp>`). Populated by `initiateDemoCall`
   * when the caller provides `instructions`; drained by the ai-twiml
   * handler which emits them as a `<Parameter>` child on the Stream.
   * Entries expire after 5 minutes to prevent unbounded growth if an
   * ai-twiml request never fires (Twilio failed to dial, etc.).
   */
  private readonly scenarios = new Map<
    string,
    { instructions: string; createdAt: number }
  >();
  private static readonly SCENARIO_TTL_MS = 5 * 60 * 1000;

  /**
   * Register a scenario both in-memory (for the demo-call hot path
   * inside this process) and in Redis (so cross-process writers
   * like the worker's approval executor can surface scenarios to
   * chat-triggered AI calls). Redis write is fire-and-forget.
   */
  registerScenario(wf: string, instructions: string): void {
    this.scenarios.set(wf, { instructions, createdAt: Date.now() });
    this.pruneScenarios();
    if (this.redis) {
      const ttlSeconds = Math.floor(CallsService.SCENARIO_TTL_MS / 1000);
      void this.redis
        .setex(`vex:call-scenario:${wf}`, ttlSeconds, instructions)
        .catch(() => {
          /* best-effort — in-memory fallback still serves demos */
        });
    }
  }

  /**
   * Read + delete a scenario for the given workflow id. Checks
   * Redis first (chat-triggered calls, worker-written) then the
   * in-memory map (demo calls inside this process). Idempotent: a
   * Twilio TwiML retry reads nothing because the first read drained
   * both stores — the bridge falls back to the default prompt.
   */
  async takeScenario(wf: string): Promise<string | null> {
    if (this.redis) {
      try {
        const key = `vex:call-scenario:${wf}`;
        const value = await this.redis.get(key);
        if (value) {
          void this.redis.del(key).catch(() => {
            /* ignore */
          });
          return value;
        }
      } catch {
        /* fall through to in-memory */
      }
    }
    const entry = this.scenarios.get(wf);
    this.scenarios.delete(wf);
    if (!entry) return null;
    if (Date.now() - entry.createdAt > CallsService.SCENARIO_TTL_MS) return null;
    return entry.instructions;
  }

  private pruneScenarios(): void {
    const cutoff = Date.now() - CallsService.SCENARIO_TTL_MS;
    for (const [key, entry] of this.scenarios) {
      if (entry.createdAt < cutoff) this.scenarios.delete(key);
    }
  }

  constructor(
    @Inject(CALLS_DB_CLIENT) private readonly db: Db,
    @Inject(CALLS_WORKSPACES_REPO) private readonly workspaces: WorkspaceRepository,
    @Inject(CALLS_CONTACTS_REPO) private readonly contacts: ContactRepository,
    @Inject(CALLS_AGENT_RUNS_REPO) private readonly agentRuns: AgentRunRepository,
    @Inject(CALLS_APPROVALS_REPO) private readonly approvals: ApprovalRepository,
    @Inject(CALLS_ACTIVITIES_REPO) private readonly activities: ActivityRepository,
    @Inject(CALLS_SUMMARIES_REPO) private readonly summaries: SummaryRepository,
    @Inject(CALLS_EVENTS_REPO) private readonly events: EventRepository,
    @Inject(CALLS_TEMPORAL_CLIENT)
    private readonly temporal: TemporalClient | null,
    @Inject(CALLS_TWILIO_CLIENT) private readonly twilio: TwilioClient,
    @Inject(CALLS_S3_UPLOADER) private readonly s3: S3Uploader,
    @Inject(CALLS_TASK_QUEUE) private readonly taskQueue: string,
    @Inject(CALLS_VOICE_SDK_CONFIG) private readonly voiceSdk: VoiceSdkConfig,
    @Inject(CALLS_APP_BASE_URL) private readonly appBaseUrl: string,
    @Inject(CALLS_TOUCHPOINTS_REPO)
    private readonly touchpoints: TouchpointRepository,
    @Inject(CALLS_RESEND_CLIENT)
    private readonly resend: ResendClient | null,
    @Inject(CALLS_REDIS_CLIENT)
    private readonly redis: Redis | null,
    @Inject(CALLS_SLACK_NOTIFIER)
    private readonly slack: SlackNotifier | null,
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

      if (!this.temporal) {
        throw new ServiceUnavailableException(
          "temporal_unavailable: OutboundCallWorkflow requires Temporal",
        );
      }
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
            hasRecording: hasPlayableRecording(activity),
          }
        : null;

      // Best-effort Temporal describe — surfaces "RUNNING" until the
      // workflow terminates. Not fatal when Temporal is unreachable;
      // the DB view is still returned.
      let workflowStatus: string | null = null;
      if (this.temporal) {
        try {
          const handle = this.temporal.workflow.getHandle(workflowId);
          const desc = await handle.describe();
          workflowStatus = desc.status.name;
        } catch {
          workflowStatus = null;
        }
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
   * Unified per-call debug surface. Joins every row the call pipeline
   * touches so an operator staring at a "my call didn't ring" moment
   * gets the whole story in one screen: approval status, agent run
   * status, every audit event keyed off `metadata.workflow_id` (window
   * rejection, suppression rejection, executor failure, twilio dial
   * result, transcript processing), the voice_call activity, and
   * Temporal's live workflow status.
   *
   * Events are returned in chronological order so the timeline
   * reads top-down. Missing pieces (no activity, no agent run) come
   * back as nulls — the UI decides how to render an incomplete run.
   */
  async getDebug(tenantId: string, workflowId: string): Promise<{
    workflowId: string;
    approval: {
      id: string;
      actionType: string;
      decision: string;
      createdAt: string;
      decidedAt: string | null;
      appliedAt: string | null;
      appliedObjectId: string | null;
      reviewerId: string | null;
      proposedPayload: Record<string, unknown>;
    } | null;
    agentRun: {
      id: string;
      agentName: string;
      status: string;
      startedAt: string;
      finishedAt: string | null;
      costUsd: number | null;
      error: string | null;
    } | null;
    activity: {
      id: string;
      type: string;
      callSid: string | null;
      status: string;
      durationSeconds: number | null;
      occurredAt: string;
    } | null;
    events: Array<{
      id: string;
      verb: string;
      actorType: string | null;
      actorId: string | null;
      occurredAt: string;
      metadata: Record<string, unknown>;
    }>;
    workflow: { status: string | null; reason: string | null } | null;
  }> {
    return withTenant(this.db, tenantId, async (tx) => {
      const approval = await this.approvals.findByWorkflowId(tx, workflowId);

      const activity = await this.activities.findByTypeAndSessionId(
        tx,
        "voice_call",
        workflowId,
      );

      // Events filtered by three overlapping keys:
      //   - metadata.workflow_id matches               (checks, executor)
      //   - subject_type=approval + subject_id=approval.id  (approval lifecycle)
      //   - subject_type=agent_run + subject_id=agentRun.id (agent run lifecycle)
      // Dedupe by event.id; sort by occurredAt ascending.
      const clauses = [
        sql`${schema.events.metadata} ->> 'workflow_id' = ${workflowId}`,
      ];
      if (approval) {
        clauses.push(
          and(
            eq(schema.events.subjectType, "approval"),
            eq(schema.events.subjectId, approval.id),
          )!,
        );
      }
      let agentRun: Awaited<ReturnType<typeof this.agentRuns.findById>> = null;
      if (approval?.agentRunId) {
        agentRun = await this.agentRuns.findById(tx, approval.agentRunId);
        if (agentRun) {
          clauses.push(
            and(
              eq(schema.events.subjectType, "agent_run"),
              eq(schema.events.subjectId, agentRun.id),
            )!,
          );
        }
      }
      const rawEvents = await tx
        .select()
        .from(schema.events)
        .where(or(...clauses))
        .orderBy(desc(schema.events.occurredAt))
        .limit(200);
      const seen = new Set<string>();
      const eventList = rawEvents
        .filter((e) => {
          if (seen.has(e.id)) return false;
          seen.add(e.id);
          return true;
        })
        .sort((a, b) => a.occurredAt.getTime() - b.occurredAt.getTime())
        .map((e) => ({
          id: e.id,
          verb: e.verb,
          actorType: e.actorType,
          actorId: e.actorId,
          occurredAt: e.occurredAt.toISOString(),
          metadata: (e.metadata ?? {}) as Record<string, unknown>,
        }));

      let workflow: { status: string | null; reason: string | null } | null =
        null;
      if (this.temporal) {
        try {
          const handle = this.temporal.workflow.getHandle(workflowId);
          const desc = await handle.describe();
          workflow = {
            status: desc.status.name,
            reason:
              typeof (desc as unknown as { closeEvent?: unknown }).closeEvent ===
              "string"
                ? ((desc as unknown as { closeEvent?: string }).closeEvent ?? null)
                : null,
          };
        } catch {
          workflow = null;
        }
      }

      const activityOut = activity
        ? {
            id: activity.id,
            type: activity.type,
            callSid:
              typeof activity.metadata["call_sid"] === "string"
                ? (activity.metadata["call_sid"] as string)
                : null,
            status:
              typeof activity.metadata["status"] === "string"
                ? (activity.metadata["status"] as string)
                : activity.result ?? "unknown",
            durationSeconds: activity.durationSeconds,
            occurredAt: activity.occurredAt.toISOString(),
          }
        : null;

      return {
        workflowId,
        approval: approval
          ? {
              id: approval.id,
              actionType: approval.actionType,
              decision: approval.decision,
              createdAt: approval.createdAt.toISOString(),
              decidedAt: approval.decidedAt?.toISOString() ?? null,
              appliedAt: approval.appliedAt?.toISOString() ?? null,
              appliedObjectId: approval.appliedObjectId,
              reviewerId: approval.reviewerId,
              proposedPayload:
                (approval.proposedPayload as Record<string, unknown>) ?? {},
            }
          : null,
        agentRun: agentRun
          ? {
              id: agentRun.id,
              agentName: agentRun.agentName,
              status: agentRun.status,
              startedAt: agentRun.startedAt?.toISOString() ?? agentRun.createdAt.toISOString(),
              finishedAt: agentRun.finishedAt?.toISOString() ?? null,
              costUsd: agentRun.costUsd,
              error: agentRun.error,
            }
          : null,
        activity: activityOut,
        events: eventList,
        workflow,
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
  /**
   * Fire a scripted-voice demo call. Bypasses the T3 approval gate
   * and the OutboundCallWorkflow — dials Twilio directly with a TwiML
   * URL that speaks the script via Polly. Used for end-to-end
   * verification of the Twilio account + Fly environment without
   * spinning up the full agent pipeline.
   *
   * Writes a `voice_call` activity row tagged `demo_call: true` so
   * the inbox shows the call but it's filterable from real calls.
   *
   * Requires APP_BASE_URL — the demo TwiML endpoint lives under the
   * same apps/api domain and Twilio needs a public HTTPS URL to fetch.
   */
  async initiateDemoCall(args: {
    tenantId: string;
    userId: string;
    toNumber: string;
    mode?: "polly" | "ai";
    script?: string;
    /** Custom scenario prompt for AI conversation mode — overrides the default fuel-qualifier. */
    instructions?: string;
  }): Promise<{ callSid: string; status: string; activityId: string }> {
    if (!this.appBaseUrl) {
      throw new ServiceUnavailableException(
        "demo_call_unconfigured: APP_BASE_URL must be set",
      );
    }
    const mode = args.mode ?? "polly";
    const baseUrl = this.appBaseUrl.replace(/\/$/, "");
    const script = args.script ?? DEFAULT_DEMO_SCRIPT;
    const wf = `demo-${Date.now()}`;
    if (mode === "ai" && args.instructions) {
      this.registerScenario(wf, args.instructions);
    }
    const twimlUrl =
      mode === "ai"
        ? `${baseUrl}/calls/twilio/ai-twiml?tenant=${encodeURIComponent(args.tenantId)}&wf=${encodeURIComponent(wf)}`
        : `${baseUrl}/calls/twilio/demo-twiml?text=${encodeURIComponent(script)}`;
    const tenantQ = encodeURIComponent(args.tenantId);
    const statusCallback = `${baseUrl}/calls/twilio/demo-status?tenant=${tenantQ}`;
    const recordingStatusCallback = `${baseUrl}/calls/twilio/demo-recording?tenant=${tenantQ}`;

    const { callSid, status } = await this.twilio.createOutboundCall({
      to: args.toNumber,
      twimlUrl,
      statusCallback,
      statusCallbackEvent: ["initiated", "ringing", "answered", "completed"],
      record: true,
      recordingStatusCallback,
      timeout: 30,
    });

    const activity = await withTenant(this.db, args.tenantId, async (tx) => {
      return this.activities.insert(tx, args.tenantId, {
        type: "voice_call",
        relatedObjectIds: {},
        occurredAt: new Date(),
        result: status,
        metadata: {
          demo_call: true,
          demo_mode: mode,
          call_sid: callSid,
          status,
          initiated_by: args.userId,
          to_number: args.toNumber,
          ...(mode === "polly" ? { script } : {}),
        },
      });
    });

    this.log.log(
      `demo call initiated: sid=${callSid} mode=${mode} to=${args.toNumber} activity=${activity.id}`,
    );
    return { callSid, status, activityId: activity.id };
  }

  /**
   * Update a demo call's activity row from a Twilio statusCallback.
   * Advances `result` through queued → ringing → in-progress →
   * completed / failed / busy / no-answer and stamps CallDuration on
   * the terminal transition. No-op if the call isn't a demo (no
   * matching activity) — the production OutboundCallWorkflow owns
   * its own status surface.
   */
  async handleDemoStatus(
    tenantId: string,
    params: Record<string, string>,
  ): Promise<void> {
    const callSid = params["CallSid"];
    const status = params["CallStatus"];
    if (!callSid || !status) return;
    const duration = Number.parseInt(params["CallDuration"] ?? "", 10);
    await withTenant(this.db, tenantId, async (tx) => {
      const row = await this.activities.findByCallSid(tx, callSid);
      if (!row) {
        this.log.warn(
          `demo-status: no voice_call activity found for callSid=${callSid} tenant=${tenantId}`,
        );
        return;
      }
      const metaPatch: Record<string, unknown> = { status };
      if (params["From"]) metaPatch["from_number"] = params["From"];
      if (params["To"]) metaPatch["to_number"] = params["To"];
      await this.activities.patchMetadata(tx, row.id, {
        result: status,
        ...(Number.isFinite(duration) && duration > 0
          ? { durationSeconds: duration }
          : {}),
        metadata: metaPatch,
      });
      this.log.log(
        `demo-status applied: activity=${row.id} status=${status} duration=${duration}`,
      );
    });
  }

  /**
   * Proxy a Twilio recording through our API so the browser doesn't
   * need Twilio basic-auth credentials to play it back. The inbox
   * detail page points its <audio> tag at this endpoint; we stream
   * the bytes from Twilio using our stored creds.
   *
   * Tenant-scoped lookup by activity id ensures the caller's JWT
   * tenant actually owns the recording they're asking for.
   */
  async fetchRecordingAudio(
    tenantId: string,
    activityId: string,
  ): Promise<Buffer> {
    const row = await withTenant(this.db, tenantId, async (tx) =>
      this.activities.findById(tx, activityId),
    );
    if (!row) throw new NotFoundException();
    const meta = (row.metadata ?? {}) as Record<string, unknown>;
    // Prod path: OutboundCallWorkflow → fetchAndStoreRecording uploads
    // the MP3 to S3 under `recordings/{tenant}/{call_sid}.mp3` and
    // stamps that key onto `transcript_ref`. We pull straight from S3
    // — no Twilio round-trip — when that key is present.
    const transcriptRef = row.transcriptRef ?? "";
    if (transcriptRef.startsWith("recordings/")) {
      const obj = await this.s3.getBuffer(transcriptRef);
      return obj.body;
    }
    // Legacy demo path: the demo-recording webhook stamps a Twilio
    // media URL onto `metadata.recording_url`; we fetch with our
    // basic-auth creds and stream it back.
    const recordingUrl =
      typeof meta["recording_url"] === "string" ? meta["recording_url"] : null;
    if (!recordingUrl) throw new NotFoundException("no recording attached");
    return this.twilio.downloadRecording(`${recordingUrl}.mp3`);
  }

  /**
   * Attach Twilio's recording URL to a demo call's activity. Twilio
   * fires this after the call ends; the URL is playable via the
   * Twilio media endpoint (auth required by the caller when fetched).
   */
  async handleDemoRecording(
    tenantId: string,
    params: Record<string, string>,
  ): Promise<void> {
    const callSid = params["CallSid"];
    const recordingSid = params["RecordingSid"];
    const recordingUrl = params["RecordingUrl"];
    if (!callSid) return;
    await withTenant(this.db, tenantId, async (tx) => {
      const row = await this.activities.findByCallSid(tx, callSid);
      if (!row) return;
      await this.activities.patchMetadata(tx, row.id, {
        metadata: {
          ...(recordingSid ? { recording_sid: recordingSid } : {}),
          ...(recordingUrl ? { recording_url: recordingUrl } : {}),
          ...(params["RecordingDuration"]
            ? {
                recording_duration_seconds: Number.parseInt(
                  params["RecordingDuration"] ?? "",
                  10,
                ),
              }
            : {}),
        },
      });
    });
  }

  /**
   * Admin-only test path for SMS + WhatsApp sends. Bypasses the
   * approval gate and provider normalizer — just fires a message
   * through the Twilio Messages API and records a touchpoint so the
   * inbox surfaces it. Used for verifying Twilio credentials + WhatsApp
   * sender config end-to-end.
   */
  async sendDemoMessage(args: {
    tenantId: string;
    userId: string;
    channel: "sms" | "whatsapp";
    toNumber: string;
    body: string;
  }): Promise<{ messageSid: string; status: string; touchpointId: string }> {
    const msg =
      args.channel === "whatsapp"
        ? await this.twilio.sendWhatsApp(args.toNumber, args.body)
        : await this.twilio.sendSms(args.toNumber, args.body);

    const touchpoint = await withTenant(this.db, args.tenantId, async (tx) => {
      return this.touchpoints.insert(tx, args.tenantId, {
        channel: `${args.channel}.sent`,
        actor: `demo.${args.userId}`,
        occurredAt: new Date(),
        metadata: {
          demo_message: true,
          direction: "outbound",
          provider_message_id: msg.sid,
          to: args.toNumber,
          text: args.body,
          preview: args.body,
        },
      });
    });

    this.log.log(
      `demo ${args.channel} sent: sid=${msg.sid} to=${args.toNumber} touchpoint=${touchpoint.id}`,
    );
    return {
      messageSid: msg.sid,
      status: msg.status ?? "queued",
      touchpointId: touchpoint.id,
    };
  }

  /**
   * Admin-only test path for email sends via Resend. Same shape as
   * sendDemoMessage — lands as an `email.sent` touchpoint so the
   * inbox surfaces it.
   */
  async sendDemoEmail(args: {
    tenantId: string;
    userId: string;
    toAddress: string;
    subject: string;
    body: string;
  }): Promise<{ messageId: string; touchpointId: string }> {
    if (!this.resend) {
      throw new ServiceUnavailableException(
        "demo_email_unconfigured: RESEND_API_KEY must be set",
      );
    }
    const sendResult = await this.resend.send({
      to: args.toAddress,
      subject: args.subject,
      text: args.body,
    });
    const messageId =
      (sendResult.data && typeof sendResult.data.id === "string"
        ? sendResult.data.id
        : null) ?? "unknown";
    if (sendResult.error) {
      throw new BadRequestException(
        `resend_error: ${sendResult.error.name}: ${sendResult.error.message}`,
      );
    }

    const touchpoint = await withTenant(this.db, args.tenantId, async (tx) => {
      return this.touchpoints.insert(tx, args.tenantId, {
        channel: "email.sent",
        actor: `demo.${args.userId}`,
        occurredAt: new Date(),
        metadata: {
          demo_message: true,
          direction: "outbound",
          provider_message_id: messageId,
          to: args.toAddress,
          subject: args.subject,
          preview: args.subject,
          text: args.body,
        },
      });
    });

    this.log.log(
      `demo email sent: id=${messageId} to=${args.toAddress} touchpoint=${touchpoint.id}`,
    );
    return { messageId, touchpointId: touchpoint.id };
  }

  async requestHumanBackup(args: {
    tenantId: string;
    workflowId: string;
    reason?: string;
    initiatedBy?: string;
  }): Promise<{ approvalId: string; existed: boolean }> {
    const result = await withTenant(this.db, args.tenantId, async (tx) => {
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
        return {
          approvalId: existing.id,
          existed: true as const,
          slackPayload: null,
        };
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

      // Grab the minimal identity context for the Slack nudge. Looked
      // up inside the tx so RLS scopes it; the actual Slack POST fires
      // outside the tx (a Slack outage can't roll back the escalation).
      // Org name isn't resolved here — we don't have an OrganizationRepo
      // injected and the Slack payload degrades gracefully without it.
      const contactId = payload.callee_contact_id;
      const contact = contactId
        ? await this.contacts.findById(tx, contactId)
        : null;
      const slackPayload = {
        workflowId: args.workflowId,
        callSid,
        calleeName: contact?.fullName ?? null,
        calleeOrg: null,
        reason: args.reason ?? null,
        durationAtRequestSeconds: durationAtRequest,
      };

      this.log.log(
        `backup requested for call ${args.workflowId} (approval=${approval.id})`,
      );
      return { approvalId: approval.id, existed: false as const, slackPayload };
    });

    // Post-commit Slack nudge. Null slack → no-op; notifier logs any
    // network error internally so the escalation flow never fails here.
    if (this.slack && result.slackPayload && !result.existed) {
      await this.slack.notifyBackupRequest(result.slackPayload);
    }
    return { approvalId: result.approvalId, existed: result.existed };
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
    tenantId: string,
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

    // Always update the voice_call activity directly so the Inbox +
    // Calls list reflect real-time status (initiated → ringing →
    // in-progress → completed). Without this, fallback-dialed calls
    // (where Temporal is null) stay frozen at dispatch status; and
    // even Temporal-path calls surface status changes faster here
    // than waiting for the workflow to re-emit to the activity.
    try {
      await withTenant(this.db, tenantId, async (tx) => {
        const row = await this.activities.findByCallSid(tx, callSid);
        if (!row) return;
        const metaPatch: Record<string, unknown> = { status };
        if (params["From"]) metaPatch["from_number"] = params["From"];
        if (params["To"]) metaPatch["to_number"] = params["To"];
        await this.activities.patchMetadata(tx, row.id, {
          result: status,
          ...(durationSeconds !== undefined &&
          Number.isFinite(durationSeconds) &&
          durationSeconds > 0
            ? { durationSeconds }
            : {}),
          metadata: metaPatch,
        });
      });
    } catch (err) {
      this.log.warn(
        `call-status activity patch failed for ${workflowId}: ${(err as Error).message}`,
      );
    }

    if (!this.temporal) {
      this.log.log(
        `call-status (no-temporal path): workflow=${workflowId} status=${status}`,
      );
      return;
    }
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

    if (!this.temporal) {
      this.log.warn(
        `call-recording signal skipped for ${workflowId}: temporal unavailable`,
      );
      return;
    }
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
/**
 * Whether the voice_call activity carries a playable recording. The
 * detail UI gates the audio player on this so the row stays clean
 * while a call is still in flight (no recording yet) or for the
 * occasional call.completed.no_recording case.
 *
 *   - Legacy demo path: Twilio's recording webhook stamps the media
 *     URL onto `metadata.recording_url`; the legacy fetchRecordingAudio
 *     branch fetches it with our basic-auth creds.
 *   - Prod path: OutboundCallWorkflow → fetchAndStoreRecording uploads
 *     the MP3 to S3 under `recordings/{tenant}/{call_sid}.mp3` and
 *     stamps that key onto `transcript_ref`.
 *
 * Either signal is enough. The shape check on `transcript_ref` keeps
 * a transcript-only ref (`transcripts/...`) from being mis-flagged.
 */
function hasPlayableRecording(activity: {
  metadata: Record<string, unknown>;
  transcriptRef: string | null;
}): boolean {
  const meta = activity.metadata ?? {};
  if (
    typeof meta["recording_url"] === "string" &&
    (meta["recording_url"] as string).length > 0
  ) {
    return true;
  }
  return (activity.transcriptRef ?? "").startsWith("recordings/");
}

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
