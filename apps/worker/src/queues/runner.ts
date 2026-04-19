import type { Job, Worker } from "bullmq";
import {
  AgentRunner,
  DailyBriefAgent,
  FollowUpAgent,
  ResearchAgent,
  backpressureEngaged,
  buildDlqProcessor,
  buildNormalizationProcessor,
  buildTranscriptProcessor,
  createAgentWorker,
  createApprovalExecutorWorker,
  createDlqWorker,
  createNormalizationWorker,
  createQueues,
  createRedisConnection,
  createTranscriptWorker,
  getQueueDepths,
  scheduleRecurringAgents,
  type AgentJobData,
  type ApprovalExecutorJobData,
  type QueueHandles,
  type TranscriptJobData,
} from "@vex/agents";
import {
  ActivityRepository,
  AgentRunRepository,
  ApprovalRepository,
  CampaignEnrollmentRepository,
  CampaignRepository,
  CampaignStepRepository,
  ContactOrgMembershipRepository,
  ContactRepository,
  EventRepository,
  FuelDealRepository,
  LeadRepository,
  OrganizationRepository,
  PostgresCostLedgerRepository,
  RawEventRepository,
  FollowUpRepository,
  RetrievalService,
  SummaryRepository,
  ThreadRepository,
  TouchpointRepository,
  WorkspaceRepository,
  withTenant,
  createDb,
  type Db,
} from "@vex/db";
import { createId } from "@vex/domain";
import type { Client as TemporalClient } from "@temporalio/client";
import {
  AnthropicAdapter,
  OpenAIAdapter,
  S3Uploader,
  TEMPORAL_TASK_QUEUE,
  WorkflowId,
  createResendClient,
  createTwilioClient,
  type TwilioClient,
} from "@vex/integrations";

type ResendClient = ReturnType<typeof createResendClient>;
import {
  InMemoryCostLedger,
  recordQueueBackpressure,
  recordQueueDepth,
} from "@vex/telemetry";

/** Interval at which the worker samples queue depths for telemetry. */
const BACKPRESSURE_SAMPLE_MS = 10_000;

export interface QueueRunnerOptions {
  redisUrl: string;
  applicationDatabaseUrl: string;
  anthropicApiKey: string;
  openaiApiKey: string;
  s3: {
    endpoint?: string;
    region: string;
    bucket: string;
    accessKeyId: string;
    secretAccessKey: string;
  };
  /**
   * Temporal client used by the approval executor's
   * `campaign.enroll_batch` branch to start
   * CampaignEnrollmentWorkflow(s). Optional — when absent, the
   * executor still materialises enrollment rows and relies on the
   * Sprint F reconciliation cron to start the workflows later.
   */
  temporal?: TemporalClient | null;
  /**
   * Sprint N — Twilio + Resend creds passed through to the approval
   * executor's messaging branches (email.send / sms.send / whatsapp.send).
   * Optional — when null those branches log `approval.executor.failed`
   * but the rest of the executor keeps working.
   */
  twilio?: {
    accountSid: string;
    authToken: string;
    fromNumber: string;
    whatsappFrom?: string;
  } | null;
  resend?: {
    apiKey: string;
    defaultFrom: string;
  } | null;
  /** Sprint 6 ships single-tenant scheduling. Sprint 7 will iterate every
   *  workspace and schedule per-workspace. */
  defaultWorkspaceId?: string;
}

export interface QueueRunner {
  queues: QueueHandles;
  normalizationWorker: Worker;
  dlqWorker: Worker;
  agentWorker: Worker<AgentJobData>;
  approvalExecutorWorker: Worker<ApprovalExecutorJobData>;
  transcriptWorker: Worker<TranscriptJobData>;
  /** Current queue-depth snapshot. Updated every BACKPRESSURE_SAMPLE_MS. */
  snapshotQueueDepths: () => Promise<Record<string, number>>;
  close: () => Promise<void>;
}

/**
 * Bootstrap every BullMQ worker the system needs. Sprint 6 adds:
 *   - the `agents` queue (DailyBrief / Research / FollowUp via AgentRunner)
 *   - the `approval-executor` queue (Sprint-6 stub — Sprint 7 wires real
 *     side effects of approved actions)
 *   - cron schedules for daily_brief and follow_up on the default workspace
 */
export async function startBullWorker(options: QueueRunnerOptions): Promise<QueueRunner> {
  const connection = createRedisConnection(options.redisUrl);
  const queues = createQueues(connection);

  const db = createDb(options.applicationDatabaseUrl);
  const repos = buildRepos();

  const normalizationProcessor = buildNormalizationProcessor({
    db,
    rawEvents: repos.rawEvents,
    contacts: repos.contacts,
    touchpoints: repos.touchpoints,
    activities: repos.activities,
    events: repos.events,
  });
  const dlqProcessor = buildDlqProcessor({
    db,
    rawEvents: repos.rawEvents,
    dlqQueue: queues.dlq,
  });

  const normalizationWorker = createNormalizationWorker(normalizationProcessor, {
    connection,
    dlqQueue: queues.dlq,
  });
  await normalizationWorker.waitUntilReady();

  const dlqWorker = createDlqWorker(dlqProcessor, connection);
  await dlqWorker.waitUntilReady();

  const costLedger = new InMemoryCostLedger();
  const anthropic = new AnthropicAdapter({ apiKey: options.anthropicApiKey, costLedger });
  const openai = new OpenAIAdapter({ apiKey: options.openaiApiKey, costLedger });
  const retrieval = new RetrievalService();

  const costLedgerRepo = new PostgresCostLedgerRepository();
  const runner = new AgentRunner({
    db,
    workspaces: repos.workspaces,
    agentRuns: repos.agentRuns,
    approvals: repos.approvals,
    organizations: repos.organizations,
    contacts: repos.contacts,
    leads: repos.leads,
    summaries: repos.summaries,
    touchpoints: repos.touchpoints,
    activities: repos.activities,
    threads: repos.threads,
    events: repos.events,
    anthropic,
    openai,
    costLedger,
    costLedgerRepo,
    retrieval,
  });

  const agentWorker = createAgentWorker(buildAgentProcessor(runner), connection);
  await agentWorker.waitUntilReady();

  const twilioForExecutor =
    options.twilio?.accountSid && options.twilio?.authToken && options.twilio?.fromNumber
      ? createTwilioClient({
          accountSid: options.twilio.accountSid,
          authToken: options.twilio.authToken,
          fromNumber: options.twilio.fromNumber,
          ...(options.twilio.whatsappFrom
            ? { whatsappFrom: options.twilio.whatsappFrom }
            : {}),
        })
      : null;
  const resendForExecutor = options.resend?.apiKey
    ? createResendClient({
        apiKey: options.resend.apiKey,
        defaultFrom: options.resend.defaultFrom,
      })
    : null;

  const approvalExecutorWorker = createApprovalExecutorWorker(
    buildApprovalExecutor({
      db,
      approvals: repos.approvals,
      agentRuns: repos.agentRuns,
      deals: repos.deals,
      organizations: repos.organizations,
      contacts: repos.contacts,
      memberships: repos.memberships,
      campaigns: repos.campaigns,
      campaignSteps: repos.campaignSteps,
      campaignEnrollments: repos.campaignEnrollments,
      touchpoints: repos.touchpoints,
      followUps: repos.followUps,
      events: repos.events,
      temporal: options.temporal ?? null,
      twilio: twilioForExecutor,
      resend: resendForExecutor,
    }),
    connection,
  );
  await approvalExecutorWorker.waitUntilReady();

  const s3 = new S3Uploader({
    region: options.s3.region,
    bucket: options.s3.bucket,
    accessKeyId: options.s3.accessKeyId,
    secretAccessKey: options.s3.secretAccessKey,
    ...(options.s3.endpoint ? { endpoint: options.s3.endpoint } : {}),
  });
  const transcriptWorker = createTranscriptWorker(
    buildTranscriptProcessor({
      db,
      s3,
      anthropic,
      openai,
      activities: repos.activities,
      touchpoints: repos.touchpoints,
      summaries: repos.summaries,
      approvals: repos.approvals,
      events: repos.events,
    }),
    connection,
  );
  await transcriptWorker.waitUntilReady();

  if (options.defaultWorkspaceId) {
    await scheduleRecurringAgents(queues.agents, options.defaultWorkspaceId);
  }

  // Sample queue depths on an interval so `vex.queue.depth` has fresh
  // datapoints and `vex.queue.backpressure` flips promptly when a queue
  // crosses its threshold.
  const sampler = setInterval(() => {
    void sampleQueueDepths(queues).catch(() => {
      // Sampling errors are never fatal — we'd rather miss a data point
      // than crash the worker.
    });
  }, BACKPRESSURE_SAMPLE_MS);
  sampler.unref();

  return {
    queues,
    normalizationWorker,
    dlqWorker,
    agentWorker,
    approvalExecutorWorker,
    transcriptWorker,
    async snapshotQueueDepths() {
      return getQueueDepths(queues);
    },
    async close() {
      clearInterval(sampler);
      await normalizationWorker.close();
      await dlqWorker.close();
      await agentWorker.close();
      await approvalExecutorWorker.close();
      await transcriptWorker.close();
      await queues.close();
      connection.disconnect();
    },
  };
}

async function sampleQueueDepths(queues: QueueHandles): Promise<void> {
  const depths = await getQueueDepths(queues);
  for (const [queue, depth] of Object.entries(depths)) {
    recordQueueDepth(queue, depth);
  }
  const engaged = new Set(backpressureEngaged(depths));
  for (const queue of Object.keys(depths)) {
    recordQueueBackpressure(queue, engaged.has(queue as never));
  }
}

function buildAgentProcessor(runner: AgentRunner) {
  return async (job: Job<AgentJobData>) => {
    const data = job.data;
    if (!data.workspace_id) throw new Error("agent job missing workspace_id");

    switch (data.kind) {
      case "daily_brief":
        return runner.run(new DailyBriefAgent(), { workspaceId: data.workspace_id });
      case "follow_up":
        return runner.run(new FollowUpAgent(), { workspaceId: data.workspace_id });
      case "research": {
        const orgId = data.input?.["organization_id"];
        if (typeof orgId !== "string") {
          throw new Error("research job missing input.organization_id");
        }
        return runner.run(new ResearchAgent({ organizationId: orgId }), {
          workspaceId: data.workspace_id,
        });
      }
      default:
        throw new Error(`unknown agent kind: ${(data as { kind: string }).kind}`);
    }
  };
}

export interface ApprovalExecutorDeps {
  db: Db;
  approvals: ApprovalRepository;
  agentRuns: AgentRunRepository;
  deals: FuelDealRepository;
  organizations: OrganizationRepository;
  contacts: ContactRepository;
  memberships: ContactOrgMembershipRepository;
  campaigns: CampaignRepository;
  campaignSteps: CampaignStepRepository;
  campaignEnrollments: CampaignEnrollmentRepository;
  touchpoints: TouchpointRepository;
  followUps: FollowUpRepository;
  events: EventRepository;
  /**
   * Best-effort Temporal client for the `campaign.enroll_batch`
   * branch. When null, the executor still materialises the
   * enrollment rows; the reconciliation cron (Sprint F) will adopt
   * them the next tick.
   */
  temporal: TemporalClient | null;
  /**
   * Twilio client for sms.send + whatsapp.send branches. Null when
   * the Twilio env vars aren't set; the executor logs
   * `approval.executor.failed` in that case.
   */
  twilio: TwilioClient | null;
  /**
   * Resend client for the email.send branch. Null when
   * RESEND_API_KEY isn't set.
   */
  resend: ResendClient | null;
}

/**
 * Approval executor. Receives an approval id after a human has
 * approved it; branches on `approval.actionType` and applies the
 * real side effect. Every branch emits an audit event so the
 * timeline reflects the executor outcome.
 *
 * Known action types:
 *   - `deal.status_change` — move a fuel deal to the target status
 *     recorded in the approval's proposed_payload. Sprint 14 Group 3.
 *
 * Other historical action types (email.send, crm.note, lead.close,
 * follow_up.suggestion, voice_followup) remain side-effect-less
 * logs for now — they'll be wired as their surface UIs land.
 */
export function buildApprovalExecutor(deps: ApprovalExecutorDeps) {
  return async (job: Job<ApprovalExecutorJobData>) => {
    const { approval_id, workspace_id } = job.data;
    await withTenant(deps.db, workspace_id, async (tx) => {
      const approval = await deps.approvals.findById(tx, approval_id);
      if (!approval) return;

      if (approval.decision === "approved") {
        if (approval.actionType === "deal.status_change") {
          await applyDealStatusChange(tx, deps, workspace_id, approval);
          return;
        }
        if (approval.actionType === "crm.create_company") {
          await applyCreateCompany(tx, deps, workspace_id, approval);
          return;
        }
        if (approval.actionType === "crm.create_contact") {
          await applyCreateContact(tx, deps, workspace_id, approval);
          return;
        }
        if (approval.actionType === "crm.create_deal") {
          await applyCreateDeal(tx, deps, workspace_id, approval);
          return;
        }
        if (approval.actionType === "campaign.enroll_batch") {
          await applyEnrollBatch(tx, deps, workspace_id, approval);
          return;
        }
        if (approval.actionType === "email.send") {
          await applyEmailSend(tx, deps, workspace_id, approval);
          return;
        }
        if (approval.actionType === "sms.send") {
          await applyMessageSend(tx, deps, workspace_id, approval, "sms");
          return;
        }
        if (approval.actionType === "whatsapp.send") {
          await applyMessageSend(tx, deps, workspace_id, approval, "whatsapp");
          return;
        }
        if (approval.actionType === "contact.opt_out") {
          await applyContactOptOut(tx, deps, workspace_id, approval);
          return;
        }
        if (approval.actionType === "outbound_call") {
          await applyOutboundCall(tx, deps, workspace_id, approval);
          return;
        }
        if (approval.actionType === "enrollment.control") {
          await applyEnrollmentControl(tx, deps, workspace_id, approval);
          return;
        }
        if (
          approval.actionType === "org.tag" ||
          approval.actionType === "org.untag" ||
          approval.actionType === "contact.tag" ||
          approval.actionType === "contact.untag"
        ) {
          await applyTagChange(tx, deps, workspace_id, approval);
          return;
        }
        if (approval.actionType === "follow_up.schedule") {
          await applyFollowUpSchedule(tx, deps, workspace_id, approval);
          return;
        }
      }

      await deps.events.insertIfNotExists(tx, workspace_id, {
        verb: "approval.executor.received",
        subjectType: "approval",
        subjectId: approval_id,
        actorType: "system",
        actorId: "approval_executor",
        objectType: "approval",
        objectId: approval_id,
        occurredAt: new Date(),
        idempotencyKey: `approval.executor:${approval_id}`,
        metadata: {
          action_type: approval.actionType,
          decision: approval.decision,
          note: "no executor wired for this action type yet",
        },
      });
    });
  };
}

/**
 * Sprint N — send an email via Resend for an approved `email.send`
 * approval. Writes an `email.sent` touchpoint so the inbox surfaces
 * it. Emits `approval.executor.failed` with the resend error on
 * failure so operators can see why.
 */
async function applyEmailSend(
  tx: Parameters<Parameters<typeof withTenant>[2]>[0],
  deps: ApprovalExecutorDeps,
  tenantId: string,
  approval: ApprovalRow,
): Promise<void> {
  const payload = approval.proposedPayload as
    | { to?: string[] | string; subject?: string; body?: string }
    | null;
  const to = Array.isArray(payload?.to) ? payload?.to : payload?.to ? [payload.to] : [];
  const subject = payload?.subject;
  const body = payload?.body;
  if (to.length === 0 || !subject || !body) {
    await emitExecutorFailed(tx, deps, tenantId, approval.id, "email.send", "missing to / subject / body");
    return;
  }
  if (!deps.resend) {
    await emitExecutorFailed(tx, deps, tenantId, approval.id, "email.send", "resend_unconfigured");
    return;
  }
  const result = await deps.resend.send({ to, subject, text: body });
  if (result.error) {
    await emitExecutorFailed(tx, deps, tenantId, approval.id, "email.send", `${result.error.name}: ${result.error.message}`);
    return;
  }
  const messageId = result.data?.id ?? "unknown";
  await deps.touchpoints.insert(tx, tenantId, {
    channel: "email.sent",
    actor: `approval:${approval.id}`,
    occurredAt: new Date(),
    metadata: {
      direction: "outbound",
      provider_message_id: messageId,
      to: to.join(", "),
      subject,
      preview: subject,
      text: body,
    },
  });
  await deps.events.insertIfNotExists(tx, tenantId, {
    verb: "approval.executor.applied",
    subjectType: "approval",
    subjectId: approval.id,
    actorType: "system",
    actorId: "approval_executor",
    objectType: "approval",
    objectId: approval.id,
    occurredAt: new Date(),
    idempotencyKey: `approval.executor:${approval.id}`,
    metadata: { action_type: "email.send", provider_message_id: messageId },
  });
}

/**
 * Sprint N — shared handler for sms.send + whatsapp.send. Fires the
 * message via Twilio's Messages API. `kind` picks the Twilio method
 * (sendSms vs sendWhatsApp) and the touchpoint channel suffix.
 */
async function applyMessageSend(
  tx: Parameters<Parameters<typeof withTenant>[2]>[0],
  deps: ApprovalExecutorDeps,
  tenantId: string,
  approval: ApprovalRow,
  kind: "sms" | "whatsapp",
): Promise<void> {
  const payload = approval.proposedPayload as
    | { to?: string; body?: string; contactId?: string }
    | null;
  const to = payload?.to;
  const body = payload?.body;
  if (!to || !body) {
    await emitExecutorFailed(tx, deps, tenantId, approval.id, `${kind}.send`, "missing to / body");
    return;
  }
  if (!deps.twilio) {
    await emitExecutorFailed(tx, deps, tenantId, approval.id, `${kind}.send`, "twilio_unconfigured");
    return;
  }
  try {
    const msg =
      kind === "whatsapp"
        ? await deps.twilio.sendWhatsApp(to, body)
        : await deps.twilio.sendSms(to, body);
    await deps.touchpoints.insert(tx, tenantId, {
      channel: `${kind}.sent`,
      actor: `approval:${approval.id}`,
      occurredAt: new Date(),
      ...(payload?.contactId ? { contactId: payload.contactId } : {}),
      metadata: {
        direction: "outbound",
        provider_message_id: msg.sid,
        to,
        text: body,
        preview: body,
      },
    });
    await deps.events.insertIfNotExists(tx, tenantId, {
      verb: "approval.executor.applied",
      subjectType: "approval",
      subjectId: approval.id,
      actorType: "system",
      actorId: "approval_executor",
      objectType: "approval",
      objectId: approval.id,
      occurredAt: new Date(),
      idempotencyKey: `approval.executor:${approval.id}`,
      metadata: {
        action_type: `${kind}.send`,
        provider_message_id: msg.sid,
      },
    });
  } catch (err) {
    await emitExecutorFailed(
      tx,
      deps,
      tenantId,
      approval.id,
      `${kind}.send`,
      (err as Error).message,
    );
  }
}

/**
 * Sprint N — opt a contact out of all outbound outreach. Matches
 * what POST /contacts/:id/optout does; the approval-initiated variant
 * records the approval id + reason so audit readers can trace who
 * decided it.
 */
async function applyContactOptOut(
  tx: Parameters<Parameters<typeof withTenant>[2]>[0],
  deps: ApprovalExecutorDeps,
  tenantId: string,
  approval: ApprovalRow,
): Promise<void> {
  const payload = approval.proposedPayload as
    | { contactId?: string; reason?: string }
    | null;
  const contactId = payload?.contactId;
  const reason = payload?.reason ?? "opted out via approval";
  if (!contactId) {
    await emitExecutorFailed(tx, deps, tenantId, approval.id, "contact.opt_out", "missing contactId");
    return;
  }
  try {
    await deps.contacts.setOptOut(tx, contactId, reason);
  } catch (err) {
    await emitExecutorFailed(
      tx,
      deps,
      tenantId,
      approval.id,
      "contact.opt_out",
      (err as Error).message,
    );
    return;
  }
  await deps.events.insertIfNotExists(tx, tenantId, {
    verb: "approval.executor.applied",
    subjectType: "contact",
    subjectId: contactId,
    actorType: "system",
    actorId: "approval_executor",
    objectType: "approval",
    objectId: approval.id,
    occurredAt: new Date(),
    idempotencyKey: `approval.executor:${approval.id}`,
    metadata: { action_type: "contact.opt_out", reason },
  });
}

/**
 * Sprint O — chat-initiated outbound call. Mirrors POST /calls:
 * creates an agent_run + a T3 approval pre-decided as approved +
 * starts the OutboundCallWorkflow + signals it so the approval
 * wait in the workflow resolves immediately. The chat approval
 * that triggered this executor is the upstream audit record; the
 * workflow-side approval is internal to the call machinery.
 */
async function applyOutboundCall(
  tx: Parameters<Parameters<typeof withTenant>[2]>[0],
  deps: ApprovalExecutorDeps,
  tenantId: string,
  approval: ApprovalRow,
): Promise<void> {
  const payload = approval.proposedPayload as
    | {
        contactId?: string;
        orgId?: string;
        toNumber?: string;
        rationale?: string;
      }
    | null;
  const contactId = payload?.contactId;
  const orgId = payload?.orgId;
  const toNumber = payload?.toNumber;
  if (!contactId || !orgId || !toNumber) {
    await emitExecutorFailed(
      tx,
      deps,
      tenantId,
      approval.id,
      "outbound_call",
      "missing contactId / orgId / toNumber",
    );
    return;
  }
  if (!deps.temporal) {
    await emitExecutorFailed(
      tx,
      deps,
      tenantId,
      approval.id,
      "outbound_call",
      "temporal_unavailable",
    );
    return;
  }

  const agentRun = await deps.agentRuns.create(tx, tenantId, {
    agentName: "outbound_call",
    inputRefs: {
      contact_id: contactId,
      org_id: orgId,
      initiated_by: "chat_agent",
      to_number: toNumber,
      chat_approval_id: approval.id,
    },
  });
  const workflowId = WorkflowId.outboundCall(agentRun.id);

  // Pre-create the approval the workflow expects + auto-decide it.
  // The workflow's createApprovalRow activity is idempotent on
  // workflow_id so it will return this row. We then signal the
  // decision so the workflow's approval.decision wait resolves.
  const innerApproval = await deps.approvals.create(tx, tenantId, {
    agentRunId: agentRun.id,
    actionType: "outbound_call",
    proposedPayload: {
      tier: "T3",
      workflow_id: workflowId,
      contact_id: contactId,
      org_id: orgId,
      to_number: toNumber,
      initiated_by: "chat_agent",
      chat_approval_id: approval.id,
    },
  });
  await deps.approvals.decide(tx, innerApproval.id, "approved", "chat_agent");

  await deps.temporal.workflow.start("outboundCallWorkflow", {
    taskQueue: TEMPORAL_TASK_QUEUE,
    workflowId,
    args: [
      {
        tenantId,
        workspaceId: tenantId,
        contactId,
        orgId,
        toNumber,
        agentRunId: agentRun.id,
        initiatedByUserId: "chat_agent",
      },
    ],
  });

  // Temporal buffers signals sent before handlers register, so this
  // resolves cleanly even when it arrives during workflow init.
  const handle = deps.temporal.workflow.getHandle(workflowId);
  await handle.signal("approval.decision", {
    approvalId: innerApproval.id,
    decision: "approved",
    reviewerId: "chat_agent",
  });

  await deps.events.insertIfNotExists(tx, tenantId, {
    verb: "approval.executor.applied",
    subjectType: "approval",
    subjectId: approval.id,
    actorType: "system",
    actorId: "approval_executor",
    objectType: "approval",
    objectId: approval.id,
    occurredAt: new Date(),
    idempotencyKey: `approval.executor:${approval.id}`,
    metadata: {
      action_type: "outbound_call",
      workflow_id: workflowId,
      agent_run_id: agentRun.id,
      inner_approval_id: innerApproval.id,
    },
  });
}

/**
 * Sprint O — steer an in-flight CampaignEnrollmentWorkflow by
 * signalling its enrollment.control handler. Looks up the workflow
 * by the deterministic workflow-id pattern
 * `campaign-enrollment-<enrollmentId>`.
 */
async function applyEnrollmentControl(
  tx: Parameters<Parameters<typeof withTenant>[2]>[0],
  deps: ApprovalExecutorDeps,
  tenantId: string,
  approval: ApprovalRow,
): Promise<void> {
  const payload = approval.proposedPayload as
    | {
        enrollmentId?: string;
        action?: "pause" | "resume" | "unsubscribe";
        note?: string;
      }
    | null;
  const enrollmentId = payload?.enrollmentId;
  const action = payload?.action;
  if (!enrollmentId || !action) {
    await emitExecutorFailed(
      tx,
      deps,
      tenantId,
      approval.id,
      "enrollment.control",
      "missing enrollmentId / action",
    );
    return;
  }
  if (!deps.temporal) {
    await emitExecutorFailed(
      tx,
      deps,
      tenantId,
      approval.id,
      "enrollment.control",
      "temporal_unavailable",
    );
    return;
  }

  const workflowId = WorkflowId.campaignEnrollment(enrollmentId);
  try {
    const handle = deps.temporal.workflow.getHandle(workflowId);
    await handle.signal("enrollment.control", {
      action,
      ...(payload?.note ? { note: payload.note } : {}),
    });
  } catch (err) {
    await emitExecutorFailed(
      tx,
      deps,
      tenantId,
      approval.id,
      "enrollment.control",
      (err as Error).message,
    );
    return;
  }

  await deps.events.insertIfNotExists(tx, tenantId, {
    verb: "approval.executor.applied",
    subjectType: "enrollment",
    subjectId: enrollmentId,
    actorType: "system",
    actorId: "approval_executor",
    objectType: "approval",
    objectId: approval.id,
    occurredAt: new Date(),
    idempotencyKey: `approval.executor:${approval.id}`,
    metadata: { action_type: "enrollment.control", signal_action: action },
  });
}

/**
 * Sprint O — append/remove a tag on an org or contact. Shared
 * handler for org.tag / org.untag / contact.tag / contact.untag.
 */
async function applyTagChange(
  tx: Parameters<Parameters<typeof withTenant>[2]>[0],
  deps: ApprovalExecutorDeps,
  tenantId: string,
  approval: ApprovalRow,
): Promise<void> {
  const payload = approval.proposedPayload as
    | { orgId?: string; contactId?: string; tag?: string }
    | null;
  const tag = payload?.tag;
  if (!tag) {
    await emitExecutorFailed(
      tx,
      deps,
      tenantId,
      approval.id,
      approval.actionType,
      "missing tag",
    );
    return;
  }

  try {
    if (approval.actionType === "org.tag" && payload?.orgId) {
      await deps.organizations.appendTag(tx, payload.orgId, tag);
    } else if (approval.actionType === "org.untag" && payload?.orgId) {
      await deps.organizations.removeTag(tx, payload.orgId, tag);
    } else if (approval.actionType === "contact.tag" && payload?.contactId) {
      await deps.contacts.appendTag(tx, payload.contactId, tag);
    } else if (approval.actionType === "contact.untag" && payload?.contactId) {
      await deps.contacts.removeTag(tx, payload.contactId, tag);
    } else {
      await emitExecutorFailed(
        tx,
        deps,
        tenantId,
        approval.id,
        approval.actionType,
        "missing orgId / contactId",
      );
      return;
    }
  } catch (err) {
    await emitExecutorFailed(
      tx,
      deps,
      tenantId,
      approval.id,
      approval.actionType,
      (err as Error).message,
    );
    return;
  }

  await deps.events.insertIfNotExists(tx, tenantId, {
    verb: "approval.executor.applied",
    subjectType:
      approval.actionType.startsWith("org.") ? "organization" : "contact",
    subjectId: payload?.orgId ?? payload?.contactId ?? approval.id,
    actorType: "system",
    actorId: "approval_executor",
    objectType: "approval",
    objectId: approval.id,
    occurredAt: new Date(),
    idempotencyKey: `approval.executor:${approval.id}`,
    metadata: { action_type: approval.actionType, tag },
  });
}

/**
 * Sprint P — insert a follow_ups row from an approved
 * `follow_up.schedule` approval. The /app/follow-ups UI surfaces
 * pending rows sorted by due_at; a future cron will fire
 * notifications as things come due.
 */
async function applyFollowUpSchedule(
  tx: Parameters<Parameters<typeof withTenant>[2]>[0],
  deps: ApprovalExecutorDeps,
  tenantId: string,
  approval: ApprovalRow,
): Promise<void> {
  const payload = approval.proposedPayload as
    | {
        title?: string;
        note?: string;
        dueAt?: string;
        subjectType?: string;
        subjectId?: string;
        assignedTo?: string;
      }
    | null;
  const title = payload?.title;
  const dueAtRaw = payload?.dueAt;
  if (!title || !dueAtRaw) {
    await emitExecutorFailed(
      tx,
      deps,
      tenantId,
      approval.id,
      "follow_up.schedule",
      "missing title / dueAt",
    );
    return;
  }
  const dueAt = new Date(dueAtRaw);
  if (Number.isNaN(dueAt.getTime())) {
    await emitExecutorFailed(
      tx,
      deps,
      tenantId,
      approval.id,
      "follow_up.schedule",
      "dueAt is not a valid date",
    );
    return;
  }

  const row = await deps.followUps.insert(tx, tenantId, {
    title,
    note: payload?.note ?? null,
    dueAt,
    subjectType: payload?.subjectType ?? null,
    subjectId: payload?.subjectId ?? null,
    assignedTo: payload?.assignedTo ?? null,
    createdBy: approval.reviewerId ?? "chat_agent",
  });

  await deps.events.insertIfNotExists(tx, tenantId, {
    verb: "approval.executor.applied",
    subjectType: "follow_up",
    subjectId: row.id,
    actorType: "system",
    actorId: "approval_executor",
    objectType: "approval",
    objectId: approval.id,
    occurredAt: new Date(),
    idempotencyKey: `approval.executor:${approval.id}`,
    metadata: {
      action_type: "follow_up.schedule",
      follow_up_id: row.id,
      due_at: dueAt.toISOString(),
    },
  });
}

async function emitExecutorFailed(
  tx: Parameters<Parameters<typeof withTenant>[2]>[0],
  deps: ApprovalExecutorDeps,
  tenantId: string,
  approvalId: string,
  actionType: string,
  reason: string,
): Promise<void> {
  await deps.events.insertIfNotExists(tx, tenantId, {
    verb: "approval.executor.failed",
    subjectType: "approval",
    subjectId: approvalId,
    actorType: "system",
    actorId: "approval_executor",
    objectType: "approval",
    objectId: approvalId,
    occurredAt: new Date(),
    idempotencyKey: `approval.executor:${approvalId}`,
    metadata: { action_type: actionType, reason },
  });
}

async function applyDealStatusChange(
  tx: Parameters<Parameters<typeof withTenant>[2]>[0],
  deps: ApprovalExecutorDeps,
  tenantId: string,
  approval: ApprovalRow,
): Promise<void> {
  const payload = approval.proposedPayload as
    | {
        deal_id?: string;
        to_status?: string;
        from_status?: string;
        rationale?: string;
        deal_ref?: string;
      }
    | null;
  const dealId = payload?.deal_id;
  const toStatus = payload?.to_status;
  if (!dealId || !toStatus) {
    await deps.events.insertIfNotExists(tx, tenantId, {
      verb: "approval.executor.failed",
      subjectType: "approval",
      subjectId: approval.id,
      actorType: "system",
      actorId: "approval_executor",
      objectType: "approval",
      objectId: approval.id,
      occurredAt: new Date(),
      idempotencyKey: `approval.executor.failed:${approval.id}`,
      metadata: {
        action_type: "deal.status_change",
        reason: "missing deal_id or to_status in proposed_payload",
      },
    });
    return;
  }

  // Idempotency — if a previous run already applied this approval,
  // skip the update. The status may have moved further since; re-
  // applying would rewind it, which is not what the reviewer approved.
  if (approval.appliedObjectId) {
    await recordExecutorReplay(tx, deps, tenantId, approval, "deal.status_change");
    return;
  }

  const actor = approval.reviewerId ?? null;
  await deps.deals.updateStatus(
    tx,
    dealId,
    toStatus as Parameters<FuelDealRepository["updateStatus"]>[2],
    actor,
  );
  await deps.approvals.markApplied(tx, approval.id, dealId);

  await deps.events.insertIfNotExists(tx, tenantId, {
    verb: "deal.status_changed",
    subjectType: "fuel_deal",
    subjectId: dealId,
    actorType: "user",
    actorId: actor ?? "approval_executor",
    objectType: "fuel_deal",
    objectId: dealId,
    occurredAt: new Date(),
    idempotencyKey: `deal.status_changed:via-approval:${approval.id}`,
    metadata: {
      approval_id: approval.id,
      deal_ref: payload?.deal_ref ?? null,
      from_status: payload?.from_status ?? null,
      to_status: toStatus,
      rationale: payload?.rationale ?? null,
      applied_by: actor,
    },
  });
}

type ApprovalRow = {
  id: string;
  actionType: string;
  proposedPayload: unknown;
  reviewerId: string | null;
  /**
   * Set once the executor has successfully applied this approval —
   * stores the created/modified entity id. Any retry that sees a
   * non-null value short-circuits instead of re-running the side
   * effect.
   */
  appliedObjectId: string | null;
};

async function applyCreateCompany(
  tx: Parameters<Parameters<typeof withTenant>[2]>[0],
  deps: ApprovalExecutorDeps,
  tenantId: string,
  approval: ApprovalRow,
): Promise<void> {
  const payload = approval.proposedPayload as {
    legalName?: string;
    domain?: string;
    industry?: string;
    rationale?: string;
  } | null;
  if (!payload?.legalName) {
    await recordExecutorFailure(tx, deps, tenantId, approval.id, "crm.create_company", "missing legalName");
    return;
  }
  // Idempotency: if a prior run of this job already created the org,
  // skip the insert and the audit. A second attempt without this
  // short-circuit would mint a fresh id and stamp a duplicate row.
  if (approval.appliedObjectId) {
    await recordExecutorReplay(tx, deps, tenantId, approval, "crm.create_company");
    return;
  }
  const newId = createId();
  // Unified dedupe — same helper the direct POST /organizations
  // path uses. If the approved payload matches an existing org,
  // mark the approval as applied against the existing id and emit
  // a replay-style audit instead of minting a duplicate.
  const result = await deps.organizations.createWithDedupeCheck(
    tx,
    tenantId,
    {
      id: newId,
      legalName: payload.legalName,
      ...(payload.domain ? { domain: payload.domain } : {}),
      ...(payload.industry ? { industry: payload.industry } : {}),
    },
  );
  if (result.kind === "duplicate") {
    await deps.approvals.markApplied(tx, approval.id, result.organization.id);
    await deps.events.insertIfNotExists(tx, tenantId, {
      verb: "approval.executor.replayed",
      subjectType: "approval",
      subjectId: approval.id,
      actorType: "system",
      actorId: "approval_executor",
      objectType: "organization",
      objectId: result.organization.id,
      occurredAt: new Date(),
      idempotencyKey: `approval.executor.replayed:${approval.id}`,
      metadata: {
        action_type: "crm.create_company",
        matched_existing: true,
        applied_object_id: result.organization.id,
        reason: "normalized-identity duplicate",
      },
    });
    return;
  }
  const id = result.organization.id;
  await deps.approvals.markApplied(tx, approval.id, id);
  await deps.events.insertIfNotExists(tx, tenantId, {
    verb: "organization.created",
    subjectType: "organization",
    subjectId: id,
    actorType: "user",
    actorId: approval.reviewerId ?? "approval_executor",
    objectType: "organization",
    objectId: id,
    occurredAt: new Date(),
    idempotencyKey: `organization.created:via-approval:${approval.id}`,
    metadata: {
      approval_id: approval.id,
      legal_name: payload.legalName,
      domain: payload.domain ?? null,
      rationale: payload.rationale ?? null,
      applied_by: approval.reviewerId,
    },
  });
}

async function applyCreateContact(
  tx: Parameters<Parameters<typeof withTenant>[2]>[0],
  deps: ApprovalExecutorDeps,
  tenantId: string,
  approval: ApprovalRow,
): Promise<void> {
  const payload = approval.proposedPayload as {
    fullName?: string;
    title?: string;
    emails?: string[];
    phones?: string[];
    orgs?: Array<{ orgId: string; role?: string; isPrimary?: boolean }>;
    rationale?: string;
  } | null;
  if (!payload?.fullName || !payload.orgs || payload.orgs.length === 0) {
    await recordExecutorFailure(tx, deps, tenantId, approval.id, "crm.create_contact", "missing fullName or orgs");
    return;
  }
  const primaryCount = payload.orgs.filter((o) => o.isPrimary).length;
  if (primaryCount > 1) {
    await recordExecutorFailure(tx, deps, tenantId, approval.id, "crm.create_contact", "more than one primary org");
    return;
  }
  // Idempotency short-circuit — see applyCreateCompany.
  if (approval.appliedObjectId) {
    await recordExecutorReplay(tx, deps, tenantId, approval, "crm.create_contact");
    return;
  }
  const normalisedOrgs =
    primaryCount === 0
      ? payload.orgs.map((o, idx) => ({ ...o, isPrimary: idx === 0 }))
      : payload.orgs;
  const primary = normalisedOrgs.find((o) => o.isPrimary)!;

  const newId = createId();
  // Unified email-dedupe — the direct POST /contacts path uses the
  // same helper. If the approved payload lands on an existing
  // contact (matching email), point the approval at the existing id
  // and skip the insert + memberships. Emit a replay-flavoured
  // audit so operators can see the approval didn't create a new row.
  const created = await deps.contacts.createWithDedupeCheck(
    tx,
    tenantId,
    {
      id: newId,
      orgId: primary.orgId,
      fullName: payload.fullName,
      ...(payload.title ? { title: payload.title } : {}),
      ...(payload.emails ? { emails: payload.emails } : {}),
      ...(payload.phones ? { phones: payload.phones } : {}),
    },
  );
  if (created.kind === "duplicate") {
    await deps.approvals.markApplied(tx, approval.id, created.contact.id);
    await deps.events.insertIfNotExists(tx, tenantId, {
      verb: "approval.executor.replayed",
      subjectType: "approval",
      subjectId: approval.id,
      actorType: "system",
      actorId: "approval_executor",
      objectType: "contact",
      objectId: created.contact.id,
      occurredAt: new Date(),
      idempotencyKey: `approval.executor.replayed:${approval.id}`,
      metadata: {
        action_type: "crm.create_contact",
        matched_existing: true,
        applied_object_id: created.contact.id,
        matched_email: created.matchedEmail,
        reason: "email-overlap duplicate",
      },
    });
    return;
  }
  const id = created.contact.id;
  // FK validation — only on the newly-created path. The duplicate
  // branch above doesn't insert any memberships, so a stale orgId
  // there shouldn't block the approval from being marked applied
  // against the matched existing contact. Without this order, an
  // email-matched duplicate with a stale secondary org would emit
  // \`approval.executor.failed\` and leave markApplied un-called.
  for (const org of normalisedOrgs) {
    const exists = await deps.organizations.findById(tx, org.orgId);
    if (!exists) {
      await recordExecutorFailure(
        tx,
        deps,
        tenantId,
        approval.id,
        "crm.create_contact",
        `orgId ${org.orgId} not found in tenant`,
      );
      return;
    }
  }
  for (const org of normalisedOrgs) {
    await deps.memberships.create(tx, tenantId, {
      contactId: id,
      orgId: org.orgId,
      role: org.role ?? null,
      isPrimary: org.isPrimary ?? false,
    });
  }
  await deps.approvals.markApplied(tx, approval.id, id);
  await deps.events.insertIfNotExists(tx, tenantId, {
    verb: "contact.created",
    subjectType: "contact",
    subjectId: id,
    actorType: "user",
    actorId: approval.reviewerId ?? "approval_executor",
    objectType: "contact",
    objectId: id,
    occurredAt: new Date(),
    idempotencyKey: `contact.created:via-approval:${approval.id}`,
    metadata: {
      approval_id: approval.id,
      full_name: payload.fullName,
      primary_org_id: primary.orgId,
      org_count: normalisedOrgs.length,
      rationale: payload.rationale ?? null,
      applied_by: approval.reviewerId,
    },
  });
}

async function applyCreateDeal(
  tx: Parameters<Parameters<typeof withTenant>[2]>[0],
  deps: ApprovalExecutorDeps,
  tenantId: string,
  approval: ApprovalRow,
): Promise<void> {
  const payload = approval.proposedPayload as {
    dealRef?: string;
    product?: string;
    incoterm?: string;
    pricingBasis?: string;
    paymentTerms?: string;
    volumeUsg?: number;
    densityKgL?: number;
    buyerOrgId?: string;
    destinationPort?: string;
    laycanStart?: string;
    laycanEnd?: string;
    notes?: string;
    rationale?: string;
  } | null;
  if (
    !payload?.dealRef ||
    !payload.product ||
    !payload.incoterm ||
    !payload.pricingBasis ||
    !payload.paymentTerms ||
    !payload.volumeUsg ||
    !payload.densityKgL ||
    !payload.buyerOrgId
  ) {
    await recordExecutorFailure(tx, deps, tenantId, approval.id, "crm.create_deal", "missing required field");
    return;
  }
  // Idempotency short-circuit — see applyCreateCompany.
  if (approval.appliedObjectId) {
    await recordExecutorReplay(tx, deps, tenantId, approval, "crm.create_deal");
    return;
  }
  // Validation parity with POST /deals: the buyer org must exist in
  // this tenant. Without this, the executor path could silently
  // accept a payload that the direct API would have rejected.
  const buyer = await deps.organizations.findById(tx, payload.buyerOrgId);
  if (!buyer) {
    await recordExecutorFailure(
      tx,
      deps,
      tenantId,
      approval.id,
      "crm.create_deal",
      `buyerOrgId ${payload.buyerOrgId} not found in tenant`,
    );
    return;
  }
  const id = createId();
  await deps.deals.create(tx, tenantId, {
    id,
    dealRef: payload.dealRef,
    product: payload.product as Parameters<FuelDealRepository["create"]>[2]["product"],
    incoterm: payload.incoterm as Parameters<FuelDealRepository["create"]>[2]["incoterm"],
    pricingBasis: payload.pricingBasis as Parameters<FuelDealRepository["create"]>[2]["pricingBasis"],
    paymentTerms: payload.paymentTerms as Parameters<FuelDealRepository["create"]>[2]["paymentTerms"],
    volumeUsg: payload.volumeUsg,
    densityKgL: payload.densityKgL,
    buyerOrgId: payload.buyerOrgId,
    ...(payload.destinationPort ? { destinationPort: payload.destinationPort } : {}),
    ...(payload.laycanStart ? { laycanStart: payload.laycanStart } : {}),
    ...(payload.laycanEnd ? { laycanEnd: payload.laycanEnd } : {}),
    ...(payload.notes ? { notes: payload.notes } : {}),
    createdBy: approval.reviewerId ?? null,
  });
  await deps.approvals.markApplied(tx, approval.id, id);
  await deps.events.insertIfNotExists(tx, tenantId, {
    verb: "deal.created",
    subjectType: "fuel_deal",
    subjectId: id,
    actorType: "user",
    actorId: approval.reviewerId ?? "approval_executor",
    objectType: "fuel_deal",
    objectId: id,
    occurredAt: new Date(),
    idempotencyKey: `deal.created:via-approval:${approval.id}`,
    metadata: {
      approval_id: approval.id,
      deal_ref: payload.dealRef,
      product: payload.product,
      buyer_org_id: payload.buyerOrgId,
      volume_usg: payload.volumeUsg,
      rationale: payload.rationale ?? null,
      applied_by: approval.reviewerId,
    },
  });
}

/**
 * Approved `campaign.enroll_batch` — materialises enrollment rows
 * and starts CampaignEnrollmentWorkflow(s). Sprint F moves the
 * enroll fan-out behind a reviewer gate: a single approval covers
 * the whole batch instead of one per step.
 *
 * Idempotency: if the approval was applied already, short-circuit
 * to a replay event. Re-validates the plan on apply because an
 * operator may have edited steps between request and approval —
 * we refuse to dispatch against a plan that's gone gap-ridden.
 *
 * Workflow start is best-effort. When Temporal is unavailable the
 * enrollment rows still land; the reconciliation cron adopts them
 * on its next tick. The idempotent enroll() ensures a partial
 * failure + retry doesn't create duplicate rows.
 */
async function applyEnrollBatch(
  tx: Parameters<Parameters<typeof withTenant>[2]>[0],
  deps: ApprovalExecutorDeps,
  tenantId: string,
  approval: ApprovalRow,
): Promise<void> {
  const payload = approval.proposedPayload as {
    campaign_id?: string;
    contact_ids?: string[];
    recipient_count?: number;
    rationale?: string;
  } | null;

  const campaignId = payload?.campaign_id;
  const contactIds = Array.isArray(payload?.contact_ids)
    ? payload!.contact_ids.filter((v): v is string => typeof v === "string" && v.length > 0)
    : [];
  if (!campaignId || contactIds.length === 0) {
    await recordExecutorFailure(
      tx,
      deps,
      tenantId,
      approval.id,
      "campaign.enroll_batch",
      "missing campaign_id or contact_ids",
    );
    return;
  }

  if (approval.appliedObjectId) {
    await recordExecutorReplay(tx, deps, tenantId, approval, "campaign.enroll_batch");
    return;
  }

  const campaign = await deps.campaigns.findById(tx, campaignId);
  if (!campaign) {
    await recordExecutorFailure(
      tx,
      deps,
      tenantId,
      approval.id,
      "campaign.enroll_batch",
      `campaign ${campaignId} not found`,
    );
    return;
  }
  const validation = await deps.campaignSteps.validateSequence(tx, campaignId);
  if (validation) {
    await recordExecutorFailure(
      tx,
      deps,
      tenantId,
      approval.id,
      "campaign.enroll_batch",
      `plan invalid at approval time: ${validation}`,
    );
    return;
  }

  const result = await deps.campaignEnrollments.enrollBatch(
    tx,
    tenantId,
    campaignId,
    contactIds,
  );

  // markApplied stamps the approval with a synthetic id that
  // survives replay — re-running won't re-enroll because the
  // appliedObjectId branch short-circuits.
  await deps.approvals.markApplied(
    tx,
    approval.id,
    `enroll:${campaignId}:${result.createdIds.length}`,
  );

  await deps.events.insertIfNotExists(tx, tenantId, {
    verb: "campaign.enrollment_batch_applied",
    subjectType: "campaign",
    subjectId: campaignId,
    actorType: "user",
    actorId: approval.reviewerId ?? "approval_executor",
    objectType: "approval",
    objectId: approval.id,
    occurredAt: new Date(),
    idempotencyKey: `campaign.enrollment_batch_applied:${approval.id}`,
    metadata: {
      approval_id: approval.id,
      campaign_id: campaignId,
      created_count: result.createdIds.length,
      existing_count: result.existingCount,
      recipient_count: payload?.recipient_count ?? contactIds.length,
      rationale: payload?.rationale ?? null,
      applied_by: approval.reviewerId,
    },
  });

  // Fire off one workflow per new enrollment. Failures during start
  // are noted but don't fail the apply — the reconciliation cron
  // picks them up.
  if (!deps.temporal || result.createdIds.length === 0) return;
  for (const enrollmentId of result.createdIds) {
    try {
      await deps.temporal.workflow.start("campaignEnrollmentWorkflow", {
        taskQueue: TEMPORAL_TASK_QUEUE,
        workflowId: WorkflowId.campaignEnrollment(enrollmentId),
        args: [{ tenantId, enrollmentId }],
      });
    } catch (err) {
      const message = (err as Error).message ?? "";
      if (!message.toLowerCase().includes("already")) {
        // eslint-disable-next-line no-console
        console.warn(
          `applyEnrollBatch: workflow start failed for ${enrollmentId}: ${message}`,
        );
      }
    }
  }
}

/**
 * Emit an observability-only event when the executor skipped a side
 * effect because the approval was already applied on a prior run.
 * Idempotency key matches the one the successful run emitted, so
 * re-running doesn't stack duplicate replay events either.
 */
async function recordExecutorReplay(
  tx: Parameters<Parameters<typeof withTenant>[2]>[0],
  deps: ApprovalExecutorDeps,
  tenantId: string,
  approval: ApprovalRow,
  actionType: string,
): Promise<void> {
  await deps.events.insertIfNotExists(tx, tenantId, {
    verb: "approval.executor.replayed",
    subjectType: "approval",
    subjectId: approval.id,
    actorType: "system",
    actorId: "approval_executor",
    objectType: "approval",
    objectId: approval.id,
    occurredAt: new Date(),
    idempotencyKey: `approval.executor.replayed:${approval.id}`,
    metadata: {
      action_type: actionType,
      applied_object_id: approval.appliedObjectId,
    },
  });
}

async function recordExecutorFailure(
  tx: Parameters<Parameters<typeof withTenant>[2]>[0],
  deps: ApprovalExecutorDeps,
  tenantId: string,
  approvalId: string,
  actionType: string,
  reason: string,
): Promise<void> {
  await deps.events.insertIfNotExists(tx, tenantId, {
    verb: "approval.executor.failed",
    subjectType: "approval",
    subjectId: approvalId,
    actorType: "system",
    actorId: "approval_executor",
    objectType: "approval",
    objectId: approvalId,
    occurredAt: new Date(),
    idempotencyKey: `approval.executor.failed:${approvalId}`,
    metadata: { action_type: actionType, reason },
  });
}

function buildRepos() {
  return {
    rawEvents: new RawEventRepository(),
    contacts: new ContactRepository(),
    touchpoints: new TouchpointRepository(),
    followUps: new FollowUpRepository(),
    activities: new ActivityRepository(),
    events: new EventRepository(),
    workspaces: new WorkspaceRepository(),
    agentRuns: new AgentRunRepository(),
    approvals: new ApprovalRepository(),
    deals: new FuelDealRepository(),
    memberships: new ContactOrgMembershipRepository(),
    organizations: new OrganizationRepository(),
    leads: new LeadRepository(),
    summaries: new SummaryRepository(),
    threads: new ThreadRepository(),
    campaigns: new CampaignRepository(),
    campaignSteps: new CampaignStepRepository(),
    campaignEnrollments: new CampaignEnrollmentRepository(),
  };
}
