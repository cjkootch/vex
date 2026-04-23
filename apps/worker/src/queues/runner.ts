import type { Job, Queue, Worker } from "bullmq";
import type { Redis } from "ioredis";
import {
  AgentRunner,
  DailyBriefAgent,
  EmailReplyDraftAgent,
  FollowUpAgent,
  FreightMarketAgent,
  LeadQualificationAgent,
  OFACScreeningAgent,
  PortIntelligenceAgent,
  ReactivationBatchAgent,
  ResearchAgent,
  backpressureEngaged,
  buildDlqProcessor,
  buildNormalizationProcessor,
  buildTranscriptProcessor,
  createAgentWorker,
  createApprovalExecutorWorker,
  createDlqWorker,
  addAgentJob,
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
  DocumentRepository,
  EventRepository,
  FuelDealRepository,
  LeadRepository,
  OrganizationProductRepository,
  OrganizationRelationshipRepository,
  OrganizationRepository,
  PostgresCostLedger,
  PostgresCostLedgerRepository,
  RawEventRepository,
  FollowUpRepository,
  RetrievalService,
  SummaryRepository,
  ThreadRepository,
  TouchpointRepository,
  WorkspaceRepository,
  schema,
  withTenant,
  createDb,
  type Db,
} from "@vex/db";
import { eq } from "drizzle-orm";
import { createId } from "@vex/domain";
import type { Client as TemporalClient } from "@temporalio/client";
import {
  AnthropicAdapter,
  OpenAIAdapter,
  S3Uploader,
  TEMPORAL_TASK_QUEUE,
  WorkflowId,
  buildDefaultSignature,
  createResendClient,
  createTwilioClient,
  renderEmailWithSignature,
  SlackNotifier,
  checkCallWindow,
  type TwilioClient,
} from "@vex/integrations";

type ResendClient = ReturnType<typeof createResendClient>;
import {
  recordQueueBackpressure,
  recordQueueDepth,
  type CostLedger,
} from "@vex/telemetry";
import { pricing, unitsToUsdMicros } from "@vex/integrations";
import { TenantId } from "@vex/domain";

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
  /**
   * Sprint S.3 — optional Slack Incoming Webhook URL. When set, hot-
   * lead qualifications (LeadQualificationAgent firing `hot: true`)
   * post a nudge to the configured channel. When null/absent, the
   * notifier no-ops silently.
   */
  slack?: {
    webhookUrl: string;
    appBaseUrl: string | null;
  } | null;
  /**
   * Twilio callback URLs used by the Temporal-less outbound_call
   * fallback. When Temporal is down (`temporal` above is null) but
   * we still have Twilio creds + an API base URL, the executor
   * dials Twilio directly instead of failing with
   * `temporal_unavailable`. Same endpoint paths the Temporal path
   * uses; constructed once in main.ts from APP_BASE_URL.
   */
  outboundCallCallbacks?: {
    twimlUrl: string;
    statusCallbackUrl: string;
    recordingCallbackUrl: string;
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
    organizations: repos.organizations,
    memberships: repos.memberships,
    leads: repos.leads,
    documents: repos.documents,
    agentsQueue: queues.agents,
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

  // Persist every LLM cost entry through to Postgres so the Admin
  // Cost tab + agent-runner daily budget gate both see real spend.
  const costLedger = new PostgresCostLedger(db);
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
    orgProducts: repos.orgProducts,
    contacts: repos.contacts,
    leads: repos.leads,
    documents: repos.documents,
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

  const slackNotifier = options.slack
    ? new SlackNotifier({
        webhookUrl: options.slack.webhookUrl,
        appBaseUrl: options.slack.appBaseUrl ?? null,
      })
    : null;

  const agentWorker = createAgentWorker(
    buildAgentProcessor(runner, slackNotifier),
    connection,
  );
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
      workspaces: repos.workspaces,
      contacts: repos.contacts,
      memberships: repos.memberships,
      campaigns: repos.campaigns,
      campaignSteps: repos.campaignSteps,
      campaignEnrollments: repos.campaignEnrollments,
      costLedger,
      touchpoints: repos.touchpoints,
      activities: repos.activities,
      followUps: repos.followUps,
      events: repos.events,
      orgProducts: repos.orgProducts,
      orgRelationships: repos.orgRelationships,
      temporal: options.temporal ?? null,
      twilio: twilioForExecutor,
      resend: resendForExecutor,
      outboundCallCallbacks: options.outboundCallCallbacks ?? null,
      redis: connection,
      agentsQueue: queues.agents,
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

function stringOrNull(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}

function buildAgentProcessor(
  runner: AgentRunner,
  slack: SlackNotifier | null,
) {
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
      case "lead_qualification": {
        const source = data.input?.["source"];
        const conversationId = data.input?.["conversation_id"];
        const leadId = data.input?.["lead_id"];
        let record;
        if (source === "website_form") {
          if (typeof leadId !== "string") {
            throw new Error(
              "lead_qualification (website_form) job missing input.lead_id",
            );
          }
          record = await runner.run(
            new LeadQualificationAgent({ source: "website_form", leadId }),
            { workspaceId: data.workspace_id },
          );
        } else {
          // Legacy + explicit `source: "website_chat"` path.
          if (typeof conversationId !== "string") {
            throw new Error(
              "lead_qualification (website_chat) job missing input.conversation_id",
            );
          }
          record = await runner.run(
            new LeadQualificationAgent({
              source: "website_chat",
              conversationId,
            }),
            { workspaceId: data.workspace_id },
          );
        }

        // Post-commit Slack nudge on hot-signal qualifications. The
        // agent's tx has already closed by the time we get here —
        // a Slack outage can't roll back the qualification write.
        // Null slack → no-op; notifier logs internally on any
        // network error.
        if (slack && record.outputRefs && record.outputRefs["hot"] === true) {
          const out = record.outputRefs;
          const qualification =
            (out["qualification"] as Record<string, unknown> | undefined) ?? {};
          await slack.notifyHotLead({
            leadId: (out["lead_id"] as string | undefined) ?? "unknown",
            contactId: (out["contact_id"] as string | null | undefined) ?? null,
            contactName: null,
            orgName: null,
            buyingIntent: stringOrNull(qualification["buying_intent"]),
            urgency: stringOrNull(qualification["urgency"]),
            product: stringOrNull(qualification["product"]),
            volume: stringOrNull(qualification["volume"]),
            destination: stringOrNull(qualification["destination"]),
            timeline: stringOrNull(qualification["timeline"]),
            summary: stringOrNull(qualification["summary"]),
            source: (out["source"] as string | undefined) ?? null,
          });
        }

        return record;
      }
      case "chat_started_notification": {
        // Lightweight Slack ping fired the moment a visitor identifies
        // themselves on the marketing chatbot. Doesn't run an LLM —
        // just relays {who, where, link} so the operator can react
        // in real time. The qualification pass on conversation.ended
        // still runs separately and produces the hot-lead nudge.
        const leadId = data.input?.["lead_id"];
        const conversationId = data.input?.["conversation_id"];
        if (typeof leadId !== "string" || typeof conversationId !== "string") {
          throw new Error(
            "chat_started_notification job missing lead_id or conversation_id",
          );
        }
        if (slack) {
          const contactEmail =
            typeof data.input?.["contact_email"] === "string"
              ? (data.input["contact_email"] as string)
              : null;
          const at = contactEmail?.lastIndexOf("@") ?? -1;
          const domain =
            contactEmail && at !== -1
              ? contactEmail.slice(at + 1).trim().toLowerCase()
              : null;
          await slack.notifyNewChat({
            leadId,
            contactId: null,
            contactName:
              typeof data.input?.["contact_name"] === "string"
                ? (data.input["contact_name"] as string)
                : null,
            contactEmail,
            orgName: domain,
            pageUrl:
              typeof data.input?.["page_url"] === "string"
                ? (data.input["page_url"] as string)
                : null,
            referrer:
              typeof data.input?.["referrer"] === "string"
                ? (data.input["referrer"] as string)
                : null,
          });
        }
        return {
          kind: "chat_started_notification",
          conversation_id: conversationId,
          lead_id: leadId,
          notified: Boolean(slack),
        };
      }
      case "reactivation_batch": {
        const contactIds = data.input?.["contact_ids"];
        const productContext = data.input?.["product_context"];
        if (!Array.isArray(contactIds) || contactIds.length === 0) {
          throw new Error("reactivation_batch job missing input.contact_ids");
        }
        if (typeof productContext !== "string" || productContext.length === 0) {
          throw new Error(
            "reactivation_batch job missing input.product_context",
          );
        }
        const angle = data.input?.["angle"];
        const parentApprovalId = data.input?.["parent_approval_id"];
        const rationale = data.input?.["rationale"];
        return runner.run(
          new ReactivationBatchAgent({
            contactIds: contactIds.filter(
              (v): v is string => typeof v === "string",
            ),
            productContext,
            ...(typeof angle === "string" ? { angle } : {}),
            ...(typeof parentApprovalId === "string"
              ? { parentApprovalId }
              : {}),
            ...(typeof rationale === "string" ? { rationale } : {}),
          }),
          { workspaceId: data.workspace_id },
        );
      }
      case "ofac_screening": {
        const orgIdRaw = data.input?.["organization_id"];
        const orgId = typeof orgIdRaw === "string" ? orgIdRaw : undefined;
        return runner.run(
          new OFACScreeningAgent(orgId ? { orgId } : {}),
          { workspaceId: data.workspace_id },
        );
      }
      case "freight_market":
        return runner.run(new FreightMarketAgent(), {
          workspaceId: data.workspace_id,
        });
      case "port_intelligence": {
        const dealIdRaw = data.input?.["deal_id"];
        const dealId = typeof dealIdRaw === "string" ? dealIdRaw : undefined;
        return runner.run(
          new PortIntelligenceAgent(dealId ? { dealId } : {}),
          { workspaceId: data.workspace_id },
        );
      }
      case "email_reply_draft": {
        const touchpointIdRaw = data.input?.["touchpoint_id"];
        if (typeof touchpointIdRaw !== "string") {
          throw new Error("email_reply_draft job missing input.touchpoint_id");
        }
        return runner.run(
          new EmailReplyDraftAgent({ touchpointId: touchpointIdRaw }),
          { workspaceId: data.workspace_id },
        );
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
  workspaces: WorkspaceRepository;
  contacts: ContactRepository;
  memberships: ContactOrgMembershipRepository;
  campaigns: CampaignRepository;
  campaignSteps: CampaignStepRepository;
  campaignEnrollments: CampaignEnrollmentRepository;
  /**
   * Shared CostLedger — each applyX branch records its own billable
   * unit (email.send, sms.send, pstn.call, web.search, …) so the
   * Admin Cost tab reflects real third-party spend, not just LLM.
   */
  costLedger: CostLedger;
  touchpoints: TouchpointRepository;
  activities: ActivityRepository;
  followUps: FollowUpRepository;
  events: EventRepository;
  orgProducts: OrganizationProductRepository;
  orgRelationships: OrganizationRelationshipRepository;
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
   * API base URL used to build Twilio callback URLs on the Temporal-
   * less outbound_call fallback (e.g. APP_BASE_URL env). Null when
   * not configured; the fallback path then emits
   * `approval.executor.failed` with a clear reason.
   */
  outboundCallCallbacks?: {
    twimlUrl: string;
    statusCallbackUrl: string;
    recordingCallbackUrl: string;
  } | null;
  /**
   * Resend client for the email.send branch. Null when
   * RESEND_API_KEY isn't set.
   */
  resend: ResendClient | null;
  /**
   * Redis client used to push custom AI-call scenario prompts over
   * the worker→API boundary for `outbound_call` approvals with
   * aiInstructions set. The API reads the same key when rendering
   * the AI TwiML for the dialed call.
   */
  redis: Redis;
  /**
   * Agents queue used to fan out downstream agent runs when an
   * approval's side effect is itself an agent run (e.g.
   * `lead.reactivate_draft` → `reactivation_batch` agent).
   */
  agentsQueue: Queue<AgentJobData>;
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
        if (approval.actionType === "contact.merge") {
          await applyContactMerge(tx, deps, workspace_id, approval);
          return;
        }
        if (approval.actionType === "contact.update") {
          await applyContactUpdate(tx, deps, workspace_id, approval);
          return;
        }
        if (approval.actionType === "campaign.create") {
          await applyCampaignCreate(tx, deps, workspace_id, approval);
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
        if (approval.actionType === "touchpoint.log") {
          await applyTouchpointLog(tx, deps, workspace_id, approval);
          return;
        }
        if (approval.actionType === "lead.reactivate_draft") {
          await applyLeadReactivateDraft(tx, deps, workspace_id, approval);
          return;
        }
        if (approval.actionType === "deal.milestone") {
          await applyDealMilestone(tx, deps, workspace_id, approval);
          return;
        }
        if (approval.actionType === "unsupported_request") {
          await applyUnsupportedRequest(tx, deps, workspace_id, approval);
          return;
        }
        if (approval.actionType === "org.set_kind") {
          await applyOrgSetKind(tx, deps, workspace_id, approval);
          return;
        }
        if (approval.actionType === "org.add_product") {
          await applyOrgAddProduct(tx, deps, workspace_id, approval);
          return;
        }
        if (approval.actionType === "org.link_relationship") {
          await applyOrgLinkRelationship(tx, deps, workspace_id, approval);
          return;
        }
        if (approval.actionType === "deal.set_broker") {
          await applyDealSetBroker(tx, deps, workspace_id, approval);
          return;
        }
        if (approval.actionType === "bundle") {
          await applyBundle(tx, deps, workspace_id, approval);
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
    | {
        to?: string[] | string;
        subject?: string;
        body?: string;
        inReplyTo?: string;
        contactId?: string;
      }
    | null;
  const to = Array.isArray(payload?.to) ? payload?.to : payload?.to ? [payload.to] : [];
  const subject = payload?.subject;
  const body = payload?.body;
  const inReplyTo = payload?.inReplyTo;
  const contactId = payload?.contactId;
  if (to.length === 0 || !subject || !body) {
    await emitExecutorFailed(tx, deps, tenantId, approval.id, "email.send", "missing to / subject / body");
    return;
  }
  if (!deps.resend) {
    await emitExecutorFailed(tx, deps, tenantId, approval.id, "email.send", "resend_unconfigured");
    return;
  }
  // Threading: when the approval is a reply to a known Message-ID,
  // pass In-Reply-To + References so Gmail / Outlook stitch the
  // reply under the original thread instead of rendering it as a
  // new conversation. Resend accepts custom headers verbatim.
  const headers = inReplyTo
    ? { "In-Reply-To": inReplyTo, References: inReplyTo }
    : undefined;

  // Signature + HTML rendering. The AI drafts plain text; the
  // renderer turns it into {text, html} with an appended signature.
  // Workspace override wins; defaults fall back to the workspace
  // name so even a fresh tenant sends something better than a raw
  // body with no sign-off.
  const workspace = await deps.workspaces.findById(deps.db, tenantId);
  const configured = workspace?.settings?.email_signature;
  const defaults = buildDefaultSignature({
    companyName: workspace?.name ?? null,
  });
  const rendered = renderEmailWithSignature({
    body,
    ...(configured ? { signature: configured } : {}),
    defaults,
  });
  const result = await deps.resend.send({
    to,
    subject,
    text: rendered.text,
    html: rendered.html,
    ...(headers ? { headers } : {}),
  });
  if (result.error) {
    await emitExecutorFailed(tx, deps, tenantId, approval.id, "email.send", `${result.error.name}: ${result.error.message}`);
    return;
  }
  const messageId = result.data?.id ?? "unknown";
  // Record Resend cost: 1 entry per recipient (Resend bills per email
  // delivered, not per API call). Best-effort — PostgresCostLedger
  // swallows errors so a ledger hiccup never fails the send.
  await deps.costLedger.record({
    idempotencyKey: `email.send:${approval.id}`,
    tenantId: TenantId(tenantId),
    operation: "email.send",
    provider: "resend",
    units: to.length,
    unitKind: "email",
    costUsdMicros: unitsToUsdMicros(to.length, pricing.resend.emailSendUsd),
    occurredAt: new Date(),
  });
  // Contact link lets the outbound touchpoint thread correctly on the
  // contact's timeline. Without it, a Reply-triggered send shows up
  // as "unlinked email" even though the reply has a known recipient.
  const orgIdForContact = contactId
    ? await deps.contacts
        .findById(tx, contactId)
        .then((c) => c?.orgId ?? null)
        .catch(() => null)
    : null;
  await deps.touchpoints.insert(tx, tenantId, {
    channel: "email.sent",
    actor: `approval:${approval.id}`,
    occurredAt: new Date(),
    ...(contactId ? { contactId } : {}),
    ...(orgIdForContact ? { orgId: orgIdForContact } : {}),
    metadata: {
      direction: "outbound",
      provider_message_id: messageId,
      to: to.join(", "),
      subject,
      preview: subject,
      text: body,
      ...(inReplyTo ? { in_reply_to: inReplyTo } : {}),
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
    // Record Twilio per-message cost. SMS is billed per segment
    // (Twilio splits >160-char bodies itself); we approximate 1
    // segment here + let real spend reconcile post-hoc via Twilio's
    // usage API (future polling job).
    const unitPrice =
      kind === "whatsapp"
        ? pricing.twilio.whatsappSessionUsd
        : pricing.twilio.smsSegmentUsd;
    await deps.costLedger.record({
      idempotencyKey: `${kind}.send:${approval.id}`,
      tenantId: TenantId(tenantId),
      operation: kind === "whatsapp" ? "whatsapp.send" : "sms.send",
      provider: "twilio",
      units: 1,
      unitKind: kind === "whatsapp" ? "session" : "segment",
      costUsdMicros: unitsToUsdMicros(1, unitPrice),
      occurredAt: new Date(),
    });
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
        aiMode?: boolean;
        aiInstructions?: string;
      }
    | null;
  const contactId = payload?.contactId;
  const orgId = payload?.orgId;
  const toNumber = payload?.toNumber;
  const aiMode = payload?.aiMode === true;
  const aiInstructions = payload?.aiInstructions ?? null;
  if (!contactId || !orgId || !toNumber) {
    const missing: string[] = [];
    if (!contactId) missing.push("contactId");
    if (!orgId) missing.push("orgId");
    if (!toNumber) missing.push("toNumber");
    await emitExecutorFailed(
      tx,
      deps,
      tenantId,
      approval.id,
      "outbound_call",
      `missing ${missing.join(" + ")}`,
    );
    return;
  }

  // Call-window gate — never dial before 9am or after 8pm in the
  // recipient's local tz. Derives the zone from the phone number
  // country + NANP area code (Caribbean area codes map to their own
  // islands). Outside the window → record the block and skip; the
  // operator can re-approve once the window opens. This is a belt-
  // and-suspenders layer on top of any workflow-level scheduling.
  const callWindow = checkCallWindow({ to: toNumber });
  if (!callWindow.ok) {
    await emitExecutorFailed(
      tx,
      deps,
      tenantId,
      approval.id,
      "outbound_call",
      callWindow.reason === "invalid_number"
        ? `invalid_phone_for_window_check: ${toNumber}`
        : `outside_call_window: local ${callWindow.localHour ?? "?"}:00 in ${callWindow.timezone ?? "unknown"}`,
    );
    return;
  }
  if (!deps.temporal) {
    // Fallback: no Temporal cluster configured. If we have Twilio +
    // a public API base URL for the TwiML callbacks, dial directly.
    // Loses the workflow state machine (auto-retry, recording→S3,
    // backup-signal waits) but delivers a ringing phone for demo /
    // test / operator-joined flows. Emit a distinct audit event so
    // the UI can still surface "applied" vs a silent failure.
    if (!deps.twilio) {
      await emitExecutorFailed(
        tx,
        deps,
        tenantId,
        approval.id,
        "outbound_call",
        "temporal_unavailable_and_no_twilio",
      );
      return;
    }
    if (!deps.outboundCallCallbacks) {
      await emitExecutorFailed(
        tx,
        deps,
        tenantId,
        approval.id,
        "outbound_call",
        "temporal_unavailable_and_no_app_base_url",
      );
      return;
    }
    if (approval.appliedObjectId) {
      await recordExecutorReplay(tx, deps, tenantId, approval, "outbound_call");
      return;
    }
    // Deterministic workflow id so the conference name + call detail
    // URL match what the rest of the system expects.
    const agentRun = await deps.agentRuns.create(tx, tenantId, {
      agentName: "outbound_call",
      inputRefs: {
        contact_id: contactId,
        org_id: orgId,
        initiated_by: "chat_agent",
        to_number: toNumber,
        chat_approval_id: approval.id,
        fallback: "direct_twilio_no_temporal",
      },
    });
    const workflowId = WorkflowId.outboundCall(agentRun.id);

    if (aiMode && aiInstructions) {
      try {
        await deps.redis.setex(
          `vex:call-scenario:${workflowId}`,
          300,
          aiInstructions,
        );
      } catch {
        /* non-fatal — call still fires with default prompt */
      }
    }

    const twimlUrl = withCallParamsForFallback(
      deps.outboundCallCallbacks.twimlUrl,
      workflowId,
      tenantId,
      aiMode,
    );
    const statusCallback = withCallParamsForFallback(
      deps.outboundCallCallbacks.statusCallbackUrl,
      workflowId,
      tenantId,
    );
    const recordingStatusCallback = withCallParamsForFallback(
      deps.outboundCallCallbacks.recordingCallbackUrl,
      workflowId,
      tenantId,
    );
    try {
      const { callSid, status } = await deps.twilio.createOutboundCall({
        to: toNumber,
        twimlUrl,
        statusCallback,
        recordingStatusCallback,
      });

      // Inner approval — mirrors the Temporal path's row so
      // CallsService.getStatus (findByWorkflowId) resolves this
      // call. Without it the /app/calls/<id> detail page 404s.
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
          twilio_call_sid: callSid,
          fallback: "direct_twilio_no_temporal",
        },
      });
      await deps.approvals.decide(tx, innerApproval.id, "auto_approved", null);

      // voice_call activity row — what the Inbox timeline queries
      // to surface in-progress calls. Temporal's call-activities
      // writes this on dispatch; the fallback has to do it inline.
      await deps.activities.insert(tx, tenantId, {
        type: "voice_call",
        relatedObjectIds: {
          contact_id: contactId,
          org_id: orgId,
          agent_run_id: agentRun.id,
          approval_id: approval.id,
        },
        occurredAt: new Date(),
        metadata: {
          session_id: workflowId,
          call_sid: callSid,
          status,
          workflow_id: workflowId,
          direction: "outbound",
          to_number: toNumber,
          fallback: "direct_twilio_no_temporal",
        },
      });

      // Transition the agent_run through its lifecycle so the
      // /app/calls list moves the row out of "In progress" once the
      // dial hand-off succeeded. Without this, every fallback call
      // sits forever in the 'pending' bucket even after it hung up.
      await deps.agentRuns.markRunning(tx, agentRun.id);
      await deps.agentRuns.complete(tx, agentRun.id, {
        status: "completed",
        costUsd: 0,
        outputRefs: {
          workflow_id: workflowId,
          twilio_call_sid: callSid,
          twilio_status: status,
          fallback: "direct_twilio_no_temporal",
        },
      });

      // Record Twilio per-call cost at dial. We don't know duration
      // yet — record as a flat pstn.call entry. Duration-based
      // reconciliation lands when the status callback patches the
      // activity with durationSeconds; a follow-up job could then
      // upsert a finer-grained pstn.minute entry.
      await deps.costLedger.record({
        idempotencyKey: `pstn.call:${approval.id}`,
        tenantId: TenantId(tenantId),
        operation: "pstn.call",
        provider: "twilio",
        units: 1,
        unitKind: "call_connect",
        costUsdMicros: unitsToUsdMicros(1, pricing.twilio.voiceMinuteUsd),
        occurredAt: new Date(),
      });

      await deps.approvals.markApplied(tx, approval.id, callSid);
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
          twilio_call_sid: callSid,
          twilio_status: status,
          fallback: "direct_twilio_no_temporal",
        },
      });
    } catch (err) {
      await deps.agentRuns.complete(tx, agentRun.id, {
        status: "failed",
        costUsd: 0,
        outputRefs: { fallback: "direct_twilio_no_temporal" },
        error: (err as Error).message,
      });
      await emitExecutorFailed(
        tx,
        deps,
        tenantId,
        approval.id,
        "outbound_call",
        `twilio_call_failed: ${(err as Error).message}`,
      );
    }
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
  await deps.approvals.decide(tx, innerApproval.id, "auto_approved", null);

  // When the user supplied custom AI instructions, stash them in
  // Redis before starting the workflow. The API's twiml handler
  // reads the same key when Twilio fetches the TwiML and threads the
  // prompt through to the OpenAI Realtime session as the system
  // instructions. 5-min TTL matches the demo-call scenario store.
  if (aiMode && aiInstructions) {
    try {
      await deps.redis.setex(
        `vex:call-scenario:${workflowId}`,
        300,
        aiInstructions,
      );
    } catch (err) {
      // Non-fatal — the call still fires, it'll use the default
      // fuel-qualifier prompt. Audit so operators can see if Redis
      // writes are silently dropping.
      await deps.events.insertIfNotExists(tx, tenantId, {
        verb: "call.scenario.register_failed",
        subjectType: "approval",
        subjectId: approval.id,
        actorType: "system",
        actorId: "approval_executor",
        objectType: "approval",
        objectId: approval.id,
        occurredAt: new Date(),
        idempotencyKey: `call.scenario.register_failed:${approval.id}`,
        metadata: {
          workflow_id: workflowId,
          error: (err as Error).message,
        },
      });
    }
  }

  // Temporal handshake: start + signal. Wrapped so any gRPC,
  // auth, or task-queue error surfaces as an `approval.executor.failed`
  // audit event rather than a silently swallowed BullMQ job. Without
  // this, "the call just didn't fire" is invisible to operators —
  // the approval row stays approved + unapplied with no clue why.
  try {
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
          ...(aiMode ? { aiMode: true } : {}),
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
  } catch (err) {
    await deps.agentRuns.complete(tx, agentRun.id, {
      status: "failed",
      costUsd: 0,
      outputRefs: { workflow_id: workflowId },
      error: (err as Error).message,
    });
    await emitExecutorFailed(
      tx,
      deps,
      tenantId,
      approval.id,
      "outbound_call",
      `temporal_start_failed: ${(err as Error).message}`,
    );
    return;
  }

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

/**
 * Sprint Q — insert a manual touchpoint from an approved
 * `touchpoint.log` approval. The action lets operators say
 * "I just called John at Acme about the Trinidad fuel deal"
 * in chat and have the contact timeline stay complete even for
 * off-platform interactions Vex didn't drive. Idempotent replay:
 * if the approval was already applied, emit a replay event and
 * return.
 */
async function applyTouchpointLog(
  tx: Parameters<Parameters<typeof withTenant>[2]>[0],
  deps: ApprovalExecutorDeps,
  tenantId: string,
  approval: ApprovalRow,
): Promise<void> {
  if (approval.appliedObjectId) {
    await recordExecutorReplay(tx, deps, tenantId, approval, "touchpoint.log");
    return;
  }
  const payload = approval.proposedPayload as
    | {
        contactId?: string;
        orgId?: string;
        dealId?: string;
        channel?: string;
        direction?: "inbound" | "outbound";
        occurredAt?: string;
        note?: string;
      }
    | null;
  const channel = payload?.channel;
  const note = payload?.note;
  if (!channel || !note) {
    await emitExecutorFailed(
      tx,
      deps,
      tenantId,
      approval.id,
      "touchpoint.log",
      "missing channel / note",
    );
    return;
  }
  const hasSubject = Boolean(
    payload?.contactId || payload?.orgId || payload?.dealId,
  );
  if (!hasSubject) {
    await emitExecutorFailed(
      tx,
      deps,
      tenantId,
      approval.id,
      "touchpoint.log",
      "missing contactId / orgId / dealId",
    );
    return;
  }
  const occurredAt = payload?.occurredAt
    ? new Date(payload.occurredAt)
    : new Date();
  if (Number.isNaN(occurredAt.getTime())) {
    await emitExecutorFailed(
      tx,
      deps,
      tenantId,
      approval.id,
      "touchpoint.log",
      "occurredAt is not a valid date",
    );
    return;
  }

  const row = await deps.touchpoints.insert(tx, tenantId, {
    channel,
    actor: `approval:${approval.id}`,
    occurredAt,
    contactId: payload?.contactId ?? null,
    orgId: payload?.orgId ?? null,
    metadata: {
      direction: payload?.direction ?? "outbound",
      note,
      manual: true,
      ...(payload?.dealId ? { deal_id: payload.dealId } : {}),
    },
  });

  await deps.approvals.markApplied(tx, approval.id, row.id);
  await deps.events.insertIfNotExists(tx, tenantId, {
    verb: "touchpoint.logged",
    subjectType: "touchpoint",
    subjectId: row.id,
    actorType: "system",
    actorId: "approval_executor",
    objectType: "approval",
    objectId: approval.id,
    occurredAt: new Date(),
    idempotencyKey: `approval.executor:${approval.id}`,
    metadata: {
      action_type: "touchpoint.log",
      touchpoint_id: row.id,
      channel,
      contact_id: payload?.contactId ?? null,
      org_id: payload?.orgId ?? null,
      deal_id: payload?.dealId ?? null,
    },
  });
}

/**
 * Sprint R — kick off a batch reactivation draft agent run. The
 * operator approves one `lead.reactivate_draft` T2; the executor
 * validates the payload and enqueues a `reactivation_batch` agent
 * job. The agent drafts one email per contact and proposes one
 * `email.send` approval per draft for individual review. This
 * executor is intentionally thin — all the multi-step fan-out
 * happens inside the agent so cost + audit trails flow through
 * the agent_runs + cost_ledger tables.
 */
async function applyLeadReactivateDraft(
  tx: Parameters<Parameters<typeof withTenant>[2]>[0],
  deps: ApprovalExecutorDeps,
  tenantId: string,
  approval: ApprovalRow,
): Promise<void> {
  if (approval.appliedObjectId) {
    await recordExecutorReplay(
      tx,
      deps,
      tenantId,
      approval,
      "lead.reactivate_draft",
    );
    return;
  }
  const payload = approval.proposedPayload as
    | {
        contactIds?: string[];
        productContext?: string;
        angle?: string;
        rationale?: string;
      }
    | null;
  const contactIds = Array.isArray(payload?.contactIds)
    ? payload!.contactIds.filter(
        (v): v is string => typeof v === "string" && v.length > 0,
      )
    : [];
  const productContext = payload?.productContext;
  if (contactIds.length === 0 || !productContext) {
    await emitExecutorFailed(
      tx,
      deps,
      tenantId,
      approval.id,
      "lead.reactivate_draft",
      "missing contactIds / productContext",
    );
    return;
  }

  await addAgentJob(
    deps.agentsQueue,
    {
      kind: "reactivation_batch",
      workspace_id: tenantId,
      input: {
        contact_ids: contactIds,
        product_context: productContext,
        angle: payload?.angle ?? null,
        parent_approval_id: approval.id,
        rationale: payload?.rationale ?? null,
      },
    },
    `reactivation:${approval.id}`,
  );

  await deps.approvals.markApplied(
    tx,
    approval.id,
    `reactivation:${approval.id}:${contactIds.length}`,
  );

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
      action_type: "lead.reactivate_draft",
      queued_contact_count: contactIds.length,
      agent_kind: "reactivation_batch",
    },
  });
}

async function applyDealMilestone(
  tx: Parameters<Parameters<typeof withTenant>[2]>[0],
  deps: ApprovalExecutorDeps,
  tenantId: string,
  approval: ApprovalRow,
): Promise<void> {
  const payload = approval.proposedPayload as
    | {
        dealId?: string;
        milestone?: string;
        occurredAt?: string;
        note?: string;
      }
    | null;
  const dealId = payload?.dealId;
  const milestone = payload?.milestone;
  if (!dealId || !milestone) {
    await emitExecutorFailed(
      tx,
      deps,
      tenantId,
      approval.id,
      "deal.milestone",
      "missing dealId / milestone",
    );
    return;
  }
  const occurredAt = payload?.occurredAt
    ? new Date(payload.occurredAt)
    : new Date();
  if (Number.isNaN(occurredAt.getTime())) {
    await emitExecutorFailed(
      tx,
      deps,
      tenantId,
      approval.id,
      "deal.milestone",
      "occurredAt is not a valid date",
    );
    return;
  }

  await deps.events.insertIfNotExists(tx, tenantId, {
    verb: `deal.milestone.${milestone}`,
    subjectType: "fuel_deal",
    subjectId: dealId,
    actorType: "system",
    actorId: "approval_executor",
    objectType: "fuel_deal",
    objectId: dealId,
    occurredAt,
    idempotencyKey: `approval.executor:${approval.id}`,
    metadata: {
      action_type: "deal.milestone",
      deal_id: dealId,
      milestone,
      ...(payload?.note ? { note: payload.note } : {}),
    },
  });

  await deps.events.insertIfNotExists(tx, tenantId, {
    verb: "approval.executor.applied",
    subjectType: "fuel_deal",
    subjectId: dealId,
    actorType: "system",
    actorId: "approval_executor",
    objectType: "approval",
    objectId: approval.id,
    occurredAt: new Date(),
    idempotencyKey: `approval.executor.applied:${approval.id}`,
    metadata: {
      action_type: "deal.milestone",
      deal_id: dealId,
      milestone,
    },
  });
}

/**
 * Sprint S — capability-gap handler. When the chat agent sees a
 * command it can't fulfil with any existing action, it emits an
 * unsupported_request descriptor instead of refusing opaquely or
 * hallucinating. The executor just logs the attempt so operators
 * can review "asks that need new actions" as a feature-request feed.
 */
/**
 * Dispatch a multi-action bundle. Each item gets a synthetic child
 * approval (phantom id `${parent.id}.item.${i}`) passed through the
 * matching handler — audit events use the phantom id so they don't
 * collide with the parent, and the parent row is marked applied
 * once at the end with a summary of what ran. Stops on the first
 * item failure and emits `approval.executor.bundle.partial` with
 * per-item results so the operator can see exactly what landed.
 *
 * The operator's unchecked items (`_unselectedItems`) never reach
 * here — the approve endpoint trims them before marking decision.
 * An empty items array after trim is treated as a no-op.
 */
async function applyBundle(
  tx: Parameters<Parameters<typeof withTenant>[2]>[0],
  deps: ApprovalExecutorDeps,
  tenantId: string,
  parent: ApprovalRow,
): Promise<void> {
  if (parent.appliedObjectId) {
    await recordExecutorReplay(tx, deps, tenantId, parent, "bundle");
    return;
  }
  const payload = parent.proposedPayload as
    | { items?: Array<{ kind?: string; payload?: Record<string, unknown> }> }
    | null;
  const items = Array.isArray(payload?.items) ? payload!.items : [];
  if (items.length === 0) {
    await emitExecutorFailed(
      tx,
      deps,
      tenantId,
      parent.id,
      "bundle",
      "empty_subset_after_trim",
    );
    return;
  }

  type ItemResult = {
    index: number;
    kind: string;
    status: "applied" | "failed" | "unknown_kind";
    reason?: string;
  };
  const results: ItemResult[] = [];

  for (let i = 0; i < items.length; i++) {
    const item = items[i] ?? {};
    const kind = typeof item.kind === "string" ? item.kind : "unknown";
    // Synthetic child — phantom id + item's payload + item's kind.
    // markApplied inside child handlers writes nothing (the id doesn't
    // match a real row) and audit events scope to the phantom id.
    const child: ApprovalRow = {
      ...parent,
      id: `${parent.id}.item.${i}`,
      actionType: kind,
      proposedPayload: (item.payload ?? {}) as Record<string, unknown>,
    };
    try {
      const dispatched = await dispatchBundleItem(tx, deps, tenantId, kind, child);
      if (!dispatched) {
        results.push({ index: i, kind, status: "unknown_kind" });
        break;
      }
      results.push({ index: i, kind, status: "applied" });
    } catch (err) {
      results.push({
        index: i,
        kind,
        status: "failed",
        reason: (err as Error).message,
      });
      break;
    }
  }

  const allOk = results.every((r) => r.status === "applied");
  if (allOk) {
    await deps.approvals.markApplied(tx, parent.id, `bundle:${items.length}`);
  }

  await deps.events.insertIfNotExists(tx, tenantId, {
    verb: allOk
      ? "approval.executor.bundle.applied"
      : "approval.executor.bundle.partial",
    subjectType: "approval",
    subjectId: parent.id,
    actorType: "system",
    actorId: "approval_executor",
    objectType: "approval",
    objectId: parent.id,
    occurredAt: new Date(),
    idempotencyKey: `approval.executor.bundle:${parent.id}`,
    metadata: {
      action_type: "bundle",
      total_items: items.length,
      applied: results.filter((r) => r.status === "applied").length,
      failed: results.filter((r) => r.status !== "applied").length,
      results,
    },
  });
}

/**
 * Map a bundle item's `kind` to the matching apply function. Returns
 * true if the kind is known (applied or threw), false if unknown so
 * the bundle flow can mark it as such without conflating "unknown"
 * with "application threw".
 */
async function dispatchBundleItem(
  tx: Parameters<Parameters<typeof withTenant>[2]>[0],
  deps: ApprovalExecutorDeps,
  tenantId: string,
  kind: string,
  child: ApprovalRow,
): Promise<boolean> {
  switch (kind) {
    case "deal.status_change":
      await applyDealStatusChange(tx, deps, tenantId, child);
      return true;
    case "crm.create_company":
      await applyCreateCompany(tx, deps, tenantId, child);
      return true;
    case "crm.create_contact":
      await applyCreateContact(tx, deps, tenantId, child);
      return true;
    case "crm.create_deal":
      await applyCreateDeal(tx, deps, tenantId, child);
      return true;
    case "campaign.enroll_batch":
      await applyEnrollBatch(tx, deps, tenantId, child);
      return true;
    case "contact.merge":
      await applyContactMerge(tx, deps, tenantId, child);
      return true;
    case "contact.update":
      await applyContactUpdate(tx, deps, tenantId, child);
      return true;
    case "campaign.create":
      await applyCampaignCreate(tx, deps, tenantId, child);
      return true;
    case "email.send":
      await applyEmailSend(tx, deps, tenantId, child);
      return true;
    case "sms.send":
      await applyMessageSend(tx, deps, tenantId, child, "sms");
      return true;
    case "whatsapp.send":
      await applyMessageSend(tx, deps, tenantId, child, "whatsapp");
      return true;
    case "contact.opt_out":
      await applyContactOptOut(tx, deps, tenantId, child);
      return true;
    case "outbound_call":
      await applyOutboundCall(tx, deps, tenantId, child);
      return true;
    case "enrollment.control":
      await applyEnrollmentControl(tx, deps, tenantId, child);
      return true;
    case "org.tag":
    case "org.untag":
    case "contact.tag":
    case "contact.untag":
      await applyTagChange(tx, deps, tenantId, child);
      return true;
    case "follow_up.schedule":
      await applyFollowUpSchedule(tx, deps, tenantId, child);
      return true;
    case "touchpoint.log":
      await applyTouchpointLog(tx, deps, tenantId, child);
      return true;
    case "lead.reactivate_draft":
      await applyLeadReactivateDraft(tx, deps, tenantId, child);
      return true;
    case "deal.milestone":
      await applyDealMilestone(tx, deps, tenantId, child);
      return true;
    case "org.set_kind":
      await applyOrgSetKind(tx, deps, tenantId, child);
      return true;
    case "org.add_product":
      await applyOrgAddProduct(tx, deps, tenantId, child);
      return true;
    case "org.link_relationship":
      await applyOrgLinkRelationship(tx, deps, tenantId, child);
      return true;
    case "deal.set_broker":
      await applyDealSetBroker(tx, deps, tenantId, child);
      return true;
    case "bundle":
      // Nested bundles aren't supported. The chat-side bundler flattens
      // them at proposal time; anything reaching here is a bug.
      return false;
    default:
      return false;
  }
}

async function applyUnsupportedRequest(
  tx: Parameters<Parameters<typeof withTenant>[2]>[0],
  deps: ApprovalExecutorDeps,
  tenantId: string,
  approval: ApprovalRow,
): Promise<void> {
  const payload = approval.proposedPayload as
    | {
        originalCommand?: string;
        reason?: string;
        suggestion?: string;
      }
    | null;
  const originalCommand = payload?.originalCommand ?? "";
  const reason = payload?.reason ?? "";

  await deps.events.insertIfNotExists(tx, tenantId, {
    verb: "chat.unsupported_request",
    subjectType: "chat",
    subjectId: approval.id,
    actorType: "system",
    actorId: "approval_executor",
    objectType: "approval",
    objectId: approval.id,
    occurredAt: new Date(),
    idempotencyKey: `approval.executor:${approval.id}`,
    metadata: {
      action_type: "unsupported_request",
      original_command: originalCommand,
      reason,
      ...(payload?.suggestion ? { suggestion: payload.suggestion } : {}),
    },
  });

  await deps.events.insertIfNotExists(tx, tenantId, {
    verb: "approval.executor.applied",
    subjectType: "chat",
    subjectId: approval.id,
    actorType: "system",
    actorId: "approval_executor",
    objectType: "approval",
    objectId: approval.id,
    occurredAt: new Date(),
    idempotencyKey: `approval.executor.applied:${approval.id}`,
    metadata: {
      action_type: "unsupported_request",
    },
  });
}

async function applyOrgSetKind(
  tx: Parameters<Parameters<typeof withTenant>[2]>[0],
  deps: ApprovalExecutorDeps,
  tenantId: string,
  approval: ApprovalRow,
): Promise<void> {
  const payload = approval.proposedPayload as
    | { orgId?: string; orgKind?: string }
    | null;
  const orgId = payload?.orgId;
  const orgKind = payload?.orgKind;
  if (!orgId || !orgKind) {
    await emitExecutorFailed(
      tx,
      deps,
      tenantId,
      approval.id,
      "org.set_kind",
      "missing orgId / orgKind",
    );
    return;
  }
  await tx
    .update(schema.organizations)
    .set({ kind: orgKind })
    .where(eq(schema.organizations.id, orgId));
  await deps.events.insertIfNotExists(tx, tenantId, {
    verb: "organization.kind_set",
    subjectType: "organization",
    subjectId: orgId,
    actorType: "system",
    actorId: "approval_executor",
    objectType: "approval",
    objectId: approval.id,
    occurredAt: new Date(),
    idempotencyKey: `approval.executor:${approval.id}`,
    metadata: { action_type: "org.set_kind", org_id: orgId, kind: orgKind },
  });
}

async function applyOrgAddProduct(
  tx: Parameters<Parameters<typeof withTenant>[2]>[0],
  deps: ApprovalExecutorDeps,
  tenantId: string,
  approval: ApprovalRow,
): Promise<void> {
  const payload = approval.proposedPayload as
    | { orgId?: string; product?: string; notes?: string }
    | null;
  const orgId = payload?.orgId;
  const product = payload?.product;
  if (!orgId || !product) {
    await emitExecutorFailed(
      tx,
      deps,
      tenantId,
      approval.id,
      "org.add_product",
      "missing orgId / product",
    );
    return;
  }
  const row = await deps.orgProducts.upsert(tx, tenantId, {
    orgId,
    product,
    notes: payload?.notes ?? null,
    addedBy: approval.reviewerId ?? "chat_agent",
  });
  await deps.events.insertIfNotExists(tx, tenantId, {
    verb: "organization.product_added",
    subjectType: "organization",
    subjectId: orgId,
    actorType: "system",
    actorId: "approval_executor",
    objectType: "approval",
    objectId: approval.id,
    occurredAt: new Date(),
    idempotencyKey: `approval.executor:${approval.id}`,
    metadata: {
      action_type: "org.add_product",
      org_id: orgId,
      product,
      org_product_id: row.id,
    },
  });
}

async function applyOrgLinkRelationship(
  tx: Parameters<Parameters<typeof withTenant>[2]>[0],
  deps: ApprovalExecutorDeps,
  tenantId: string,
  approval: ApprovalRow,
): Promise<void> {
  const payload = approval.proposedPayload as
    | {
        fromOrgId?: string;
        toOrgId?: string;
        relationshipType?: string;
        product?: string;
        notes?: string;
      }
    | null;
  const fromOrgId = payload?.fromOrgId;
  const toOrgId = payload?.toOrgId;
  const relationshipType = payload?.relationshipType;
  if (!fromOrgId || !toOrgId || !relationshipType) {
    await emitExecutorFailed(
      tx,
      deps,
      tenantId,
      approval.id,
      "org.link_relationship",
      "missing fromOrgId / toOrgId / relationshipType",
    );
    return;
  }
  if (fromOrgId === toOrgId) {
    await emitExecutorFailed(
      tx,
      deps,
      tenantId,
      approval.id,
      "org.link_relationship",
      "from_org and to_org must differ",
    );
    return;
  }
  const row = await deps.orgRelationships.upsert(tx, tenantId, {
    fromOrgId,
    toOrgId,
    relationshipType,
    product: payload?.product ?? null,
    notes: payload?.notes ?? null,
    addedBy: approval.reviewerId ?? "chat_agent",
  });
  await deps.events.insertIfNotExists(tx, tenantId, {
    verb: "organization.relationship_linked",
    subjectType: "organization",
    subjectId: fromOrgId,
    actorType: "system",
    actorId: "approval_executor",
    objectType: "approval",
    objectId: approval.id,
    occurredAt: new Date(),
    idempotencyKey: `approval.executor:${approval.id}`,
    metadata: {
      action_type: "org.link_relationship",
      from_org_id: fromOrgId,
      to_org_id: toOrgId,
      relationship_type: relationshipType,
      product: payload?.product ?? null,
      relationship_id: row.id,
    },
  });
}

async function applyDealSetBroker(
  tx: Parameters<Parameters<typeof withTenant>[2]>[0],
  deps: ApprovalExecutorDeps,
  tenantId: string,
  approval: ApprovalRow,
): Promise<void> {
  const payload = approval.proposedPayload as
    | {
        dealId?: string;
        side?: "buy" | "sell";
        brokerOrgId?: string;
        commissionPct?: number;
        paymentTerms?: string;
      }
    | null;
  const dealId = payload?.dealId;
  const side = payload?.side;
  const brokerOrgId = payload?.brokerOrgId;
  if (!dealId || !side || !brokerOrgId) {
    await emitExecutorFailed(
      tx,
      deps,
      tenantId,
      approval.id,
      "deal.set_broker",
      "missing dealId / side / brokerOrgId",
    );
    return;
  }
  const patch: Record<string, unknown> = {};
  if (side === "buy") {
    patch["buy_side_broker_org_id"] = brokerOrgId;
    if (payload?.commissionPct !== undefined) {
      patch["buy_side_broker_commission_pct"] = payload.commissionPct;
    }
    if (payload?.paymentTerms !== undefined) {
      patch["buy_side_broker_payment_terms"] = payload.paymentTerms;
    }
  } else {
    patch["sell_side_broker_org_id"] = brokerOrgId;
    if (payload?.commissionPct !== undefined) {
      patch["sell_side_broker_commission_pct"] = payload.commissionPct;
    }
    if (payload?.paymentTerms !== undefined) {
      patch["sell_side_broker_payment_terms"] = payload.paymentTerms;
    }
  }
  await tx
    .update(schema.fuelDeals)
    .set(patch)
    .where(eq(schema.fuelDeals.id, dealId));
  await deps.events.insertIfNotExists(tx, tenantId, {
    verb: `deal.broker.${side}_side_set`,
    subjectType: "fuel_deal",
    subjectId: dealId,
    actorType: "system",
    actorId: "approval_executor",
    objectType: "approval",
    objectId: approval.id,
    occurredAt: new Date(),
    idempotencyKey: `approval.executor:${approval.id}`,
    metadata: {
      action_type: "deal.set_broker",
      deal_id: dealId,
      side,
      broker_org_id: brokerOrgId,
      commission_pct: payload?.commissionPct ?? null,
      payment_terms: payload?.paymentTerms ?? null,
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
        duplicate_reason: created.reason,
        matched_value: created.matchedValue,
        reason: `${created.reason} duplicate`,
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
 * Append the wf + tenant query params Twilio needs on every callback
 * URL. Mirrors withCallParams in call-activities.ts so the Temporal
 * and Temporal-less paths hit the same API endpoints.
 */
function withCallParamsForFallback(
  baseUrl: string,
  workflowId: string,
  tenantId: string,
  aiMode?: boolean,
): string {
  const joinChar = baseUrl.includes("?") ? "&" : "?";
  const extras = aiMode ? "&aiMode=true" : "";
  return `${baseUrl}${joinChar}wf=${encodeURIComponent(workflowId)}&tenant=${encodeURIComponent(tenantId)}${extras}`;
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
 * Approved `contact.update` — patch an existing contact's editable
 * fields (fullName, title, emails, phones, timezone, tags).
 * Arrays are full replacements, not appends. The agent-side zod
 * descriptor already enforced "at least one field present" and
 * E.164 on phones, so this branch just relays the patch and emits
 * an audit event.
 */
async function applyContactUpdate(
  tx: Parameters<Parameters<typeof withTenant>[2]>[0],
  deps: ApprovalExecutorDeps,
  tenantId: string,
  approval: ApprovalRow,
): Promise<void> {
  const payload = approval.proposedPayload as {
    contactId?: string;
    patch?: Record<string, unknown> | null;
    rationale?: string;
  } | null;
  const contactId = payload?.contactId;
  const patch = payload?.patch;
  if (!contactId || !patch || typeof patch !== "object") {
    const missing: string[] = [];
    if (!contactId) missing.push("contactId");
    if (!patch) missing.push("patch");
    await emitExecutorFailed(
      tx,
      deps,
      tenantId,
      approval.id,
      "contact.update",
      `missing ${missing.join(" + ")}`,
    );
    return;
  }
  if (approval.appliedObjectId) {
    await recordExecutorReplay(tx, deps, tenantId, approval, "contact.update");
    return;
  }
  try {
    const updated = await deps.contacts.updatePatch(tx, contactId, {
      ...(typeof patch["fullName"] === "string" ? { fullName: patch["fullName"] } : {}),
      ...("title" in patch ? { title: patch["title"] as string | null } : {}),
      ...(Array.isArray(patch["emails"]) ? { emails: patch["emails"] as string[] } : {}),
      ...(Array.isArray(patch["phones"]) ? { phones: patch["phones"] as string[] } : {}),
      ...("timezone" in patch
        ? { timezone: patch["timezone"] as string | null }
        : {}),
      ...(Array.isArray(patch["tags"]) ? { tags: patch["tags"] as string[] } : {}),
    });
    await deps.approvals.markApplied(tx, approval.id, updated.id);
    await deps.events.insertIfNotExists(tx, tenantId, {
      verb: "contact.updated",
      subjectType: "contact",
      subjectId: updated.id,
      actorType: "user",
      actorId: approval.reviewerId ?? "approval_executor",
      objectType: "contact",
      objectId: updated.id,
      occurredAt: new Date(),
      idempotencyKey: `contact.updated:${approval.id}`,
      metadata: {
        approval_id: approval.id,
        fields: Object.keys(patch),
        rationale: payload?.rationale ?? null,
        applied_by: approval.reviewerId,
      },
    });
  } catch (err) {
    await emitExecutorFailed(
      tx,
      deps,
      tenantId,
      approval.id,
      "contact.update",
      (err as Error).message,
    );
  }
}

/**
 * Approved `contact.merge` — unify two contact records. Delegates to
 * ContactRepository.mergeInto which rewrites FKs (touchpoints,
 * activities, leads, memberships), unions emails/phones/tags onto
 * the target, and tombstones the source
 * (status=archived + merged_into_contact_id=target). All in one
 * `withTenant` tx so a crash rolls the whole thing back.
 *
 * Idempotent: if `sourceContactId` is already merged into the same
 * target, the repo returns without re-running + we replay-event.
 */
async function applyContactMerge(
  tx: Parameters<Parameters<typeof withTenant>[2]>[0],
  deps: ApprovalExecutorDeps,
  tenantId: string,
  approval: ApprovalRow,
): Promise<void> {
  const payload = approval.proposedPayload as {
    sourceContactId?: string;
    targetContactId?: string;
    rationale?: string;
  } | null;
  const sourceContactId = payload?.sourceContactId;
  const targetContactId = payload?.targetContactId;
  if (!sourceContactId || !targetContactId) {
    const missing: string[] = [];
    if (!sourceContactId) missing.push("sourceContactId");
    if (!targetContactId) missing.push("targetContactId");
    await emitExecutorFailed(
      tx,
      deps,
      tenantId,
      approval.id,
      "contact.merge",
      `missing ${missing.join(" + ")}`,
    );
    return;
  }
  if (sourceContactId === targetContactId) {
    await emitExecutorFailed(
      tx,
      deps,
      tenantId,
      approval.id,
      "contact.merge",
      "source and target are the same contact",
    );
    return;
  }
  if (approval.appliedObjectId) {
    await recordExecutorReplay(tx, deps, tenantId, approval, "contact.merge");
    return;
  }

  try {
    const { target } = await deps.contacts.mergeInto(
      tx,
      sourceContactId,
      targetContactId,
    );
    await deps.approvals.markApplied(tx, approval.id, target.id);
    await deps.events.insertIfNotExists(tx, tenantId, {
      verb: "contact.merged",
      subjectType: "contact",
      subjectId: target.id,
      actorType: "user",
      actorId: approval.reviewerId ?? "approval_executor",
      objectType: "contact",
      objectId: sourceContactId,
      occurredAt: new Date(),
      idempotencyKey: `contact.merged:${approval.id}`,
      metadata: {
        approval_id: approval.id,
        source_contact_id: sourceContactId,
        target_contact_id: target.id,
        rationale: payload?.rationale ?? null,
        applied_by: approval.reviewerId,
      },
    });
  } catch (err) {
    await emitExecutorFailed(
      tx,
      deps,
      tenantId,
      approval.id,
      "contact.merge",
      (err as Error).message,
    );
  }
}

/**
 * Approved `campaign.create` — materialise a new campaigns row + all
 * its campaign_steps rows in one transaction. Sprint T.4 unlocks the
 * chat agent to DESIGN a workflow end-to-end: when the campaigns
 * catalog doesn't have a plan that fits, the agent proposes a
 * multi-channel cadence and the operator approves the whole thing
 * at once.
 *
 * On success stamps `appliedObjectId = <new campaign id>` so a
 * `campaign.enroll_batch` proposed against the same id right after
 * can resolve it via approval metadata if it lands before the
 * approvals inbox refreshes.
 *
 * Idempotency: markApplied with the new campaign's id. Replay short-
 * circuits via recordExecutorReplay — the tx commit is the
 * synchronisation point so a crash between `campaigns.create` and
 * `campaignSteps.create` rolls the whole thing back.
 */
async function applyCampaignCreate(
  tx: Parameters<Parameters<typeof withTenant>[2]>[0],
  deps: ApprovalExecutorDeps,
  tenantId: string,
  approval: ApprovalRow,
): Promise<void> {
  interface StepInput {
    position?: number;
    channel?: string;
    delayAfterPriorMs?: number;
    tier?: string;
    autoApprove?: boolean;
    templateRef?: string | null;
    gateConditionJson?: Record<string, unknown>;
  }
  const payload = approval.proposedPayload as {
    name?: string;
    channel?: string;
    objective?: string;
    steps?: StepInput[];
    rationale?: string;
  } | null;

  if (
    !payload?.name ||
    !payload.channel ||
    !Array.isArray(payload.steps) ||
    payload.steps.length === 0
  ) {
    await recordExecutorFailure(
      tx,
      deps,
      tenantId,
      approval.id,
      "campaign.create",
      "missing name / channel / steps",
    );
    return;
  }

  if (approval.appliedObjectId) {
    await recordExecutorReplay(tx, deps, tenantId, approval, "campaign.create");
    return;
  }

  // Normalise step shape + check for position gaps before any insert
  // so a bad plan fails with a clean message instead of a partial write.
  const steps = [...payload.steps].sort(
    (a, b) => (a.position ?? 0) - (b.position ?? 0),
  );
  for (let i = 0; i < steps.length; i++) {
    const s = steps[i]!;
    if (typeof s.position !== "number" || s.position !== i) {
      await recordExecutorFailure(
        tx,
        deps,
        tenantId,
        approval.id,
        "campaign.create",
        `step positions must be 0..${steps.length - 1} contiguous; saw ${JSON.stringify(steps.map((x) => x.position))}`,
      );
      return;
    }
    if (!s.channel) {
      await recordExecutorFailure(
        tx,
        deps,
        tenantId,
        approval.id,
        "campaign.create",
        `step ${s.position} is missing channel`,
      );
      return;
    }
  }

  // Persist the campaign header — objective holds the operator-facing
  // name (there's no dedicated `name` column on `campaigns`; the Marketing
  // page renders `objective || "(untitled)"` today). The channel column
  // takes the plan-level dominant channel ("email" / "multi" / etc).
  const campaign = await deps.campaigns.create(tx, tenantId, {
    channel: payload.channel,
    objective: payload.name,
    ...(payload.objective ? { source: payload.objective } : {}),
  });

  // Insert each step inside the same tx. CampaignStepRepository.create
  // stamps tenant_id and defaults the rest.
  for (const s of steps) {
    await deps.campaignSteps.create(tx, tenantId, {
      campaignId: campaign.id,
      position: s.position!,
      channel: s.channel!,
      delayAfterPriorMs: s.delayAfterPriorMs ?? 0,
      tier: s.tier ?? "T2",
      autoApprove: s.autoApprove ?? false,
      templateRef: s.templateRef ?? null,
      gateConditionJson: s.gateConditionJson ?? {},
    });
  }

  await deps.approvals.markApplied(tx, approval.id, campaign.id);

  await deps.events.insertIfNotExists(tx, tenantId, {
    verb: "campaign.created",
    subjectType: "campaign",
    subjectId: campaign.id,
    actorType: "user",
    actorId: approval.reviewerId ?? "approval_executor",
    objectType: "approval",
    objectId: approval.id,
    occurredAt: new Date(),
    idempotencyKey: `campaign.created:${approval.id}`,
    metadata: {
      approval_id: approval.id,
      campaign_id: campaign.id,
      name: payload.name,
      channel: payload.channel,
      step_count: steps.length,
      rationale: payload.rationale ?? null,
      applied_by: approval.reviewerId,
    },
  });
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
    orgProducts: new OrganizationProductRepository(),
    orgRelationships: new OrganizationRelationshipRepository(),
    activities: new ActivityRepository(),
    events: new EventRepository(),
    workspaces: new WorkspaceRepository(),
    agentRuns: new AgentRunRepository(),
    approvals: new ApprovalRepository(),
    deals: new FuelDealRepository(),
    memberships: new ContactOrgMembershipRepository(),
    organizations: new OrganizationRepository(),
    leads: new LeadRepository(),
    documents: new DocumentRepository(),
    summaries: new SummaryRepository(),
    threads: new ThreadRepository(),
    campaigns: new CampaignRepository(),
    campaignSteps: new CampaignStepRepository(),
    campaignEnrollments: new CampaignEnrollmentRepository(),
  };
}
