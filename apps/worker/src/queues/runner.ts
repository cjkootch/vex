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
  ContactOrgMembershipRepository,
  ContactRepository,
  EventRepository,
  FuelDealRepository,
  LeadRepository,
  OrganizationRepository,
  PostgresCostLedgerRepository,
  RawEventRepository,
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
import { AnthropicAdapter, OpenAIAdapter, S3Uploader } from "@vex/integrations";
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

  const approvalExecutorWorker = createApprovalExecutorWorker(
    buildApprovalExecutor({
      db,
      approvals: repos.approvals,
      deals: repos.deals,
      organizations: repos.organizations,
      contacts: repos.contacts,
      memberships: repos.memberships,
      events: repos.events,
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

interface ApprovalExecutorDeps {
  db: Db;
  approvals: ApprovalRepository;
  deals: FuelDealRepository;
  organizations: OrganizationRepository;
  contacts: ContactRepository;
  memberships: ContactOrgMembershipRepository;
  events: EventRepository;
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
function buildApprovalExecutor(deps: ApprovalExecutorDeps) {
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

async function applyDealStatusChange(
  tx: Parameters<Parameters<typeof withTenant>[2]>[0],
  deps: ApprovalExecutorDeps,
  tenantId: string,
  approval: { id: string; proposedPayload: unknown; reviewerId: string | null },
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

  const actor = approval.reviewerId ?? null;
  await deps.deals.updateStatus(
    tx,
    dealId,
    toStatus as Parameters<FuelDealRepository["updateStatus"]>[2],
    actor,
  );

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

type ApprovalRow = { id: string; proposedPayload: unknown; reviewerId: string | null };

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
  const id = createId();
  await deps.organizations.create(tx, tenantId, {
    id,
    legalName: payload.legalName,
    ...(payload.domain ? { domain: payload.domain } : {}),
    ...(payload.industry ? { industry: payload.industry } : {}),
  });
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
  const normalisedOrgs =
    primaryCount === 0
      ? payload.orgs.map((o, idx) => ({ ...o, isPrimary: idx === 0 }))
      : payload.orgs;
  const primary = normalisedOrgs.find((o) => o.isPrimary)!;

  const id = createId();
  await deps.contacts.create(tx, tenantId, {
    id,
    orgId: primary.orgId,
    fullName: payload.fullName,
    ...(payload.title ? { title: payload.title } : {}),
    ...(payload.emails ? { emails: payload.emails } : {}),
    ...(payload.phones ? { phones: payload.phones } : {}),
  });
  for (const org of normalisedOrgs) {
    await deps.memberships.create(tx, tenantId, {
      contactId: id,
      orgId: org.orgId,
      role: org.role ?? null,
      isPrimary: org.isPrimary ?? false,
    });
  }
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
  };
}
