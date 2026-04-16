import type { Job, Worker } from "bullmq";
import {
  AgentRunner,
  DailyBriefAgent,
  FollowUpAgent,
  MarketingAnalystAgent,
  ResearchAgent,
  buildDlqProcessor,
  buildNormalizationProcessor,
  createAgentWorker,
  createApprovalExecutorWorker,
  createDlqWorker,
  createNormalizationWorker,
  createQueues,
  createRedisConnection,
  scheduleRecurringAgents,
  type AgentJobData,
  type ApprovalExecutorJobData,
  type MarketingAnalystInput,
  type QueueHandles,
} from "@vex/agents";
import {
  ActivityRepository,
  AgentRunRepository,
  ApprovalRepository,
  CampaignRepository,
  ContactRepository,
  EventRepository,
  LeadRepository,
  OrganizationRepository,
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
import { AnthropicAdapter, GA4Adapter, OpenAIAdapter } from "@vex/integrations";
import { InMemoryCostLedger } from "@vex/telemetry";
import { runGa4Poll } from "../jobs/ga4-poll.js";
import { buildMarketingAnalystInput } from "../jobs/marketing-input.js";

export interface QueueRunnerOptions {
  redisUrl: string;
  applicationDatabaseUrl: string;
  anthropicApiKey: string;
  openaiApiKey: string;
  /** Sprint 6 ships single-tenant scheduling. Sprint 7 will iterate every
   *  workspace and schedule per-workspace. */
  defaultWorkspaceId?: string;
  /** Service-account JSON for GA4 polling. When unset, the GA4 poll job
   *  runs but skips with `service_account_unset`. */
  googleServiceAccountJson?: string | null;
}

export interface QueueRunner {
  queues: QueueHandles;
  normalizationWorker: Worker;
  dlqWorker: Worker;
  agentWorker: Worker<AgentJobData>;
  approvalExecutorWorker: Worker<ApprovalExecutorJobData>;
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
    retrieval,
  });

  const ga4Factory = (sa: string): GA4Adapter => new GA4Adapter({ serviceAccount: sa });
  const ga4PollDeps = {
    db,
    workspaces: repos.workspaces,
    campaigns: repos.campaigns,
    touchpoints: repos.touchpoints,
    events: repos.events,
    ga4Factory,
  };
  const marketingInputDeps = {
    db,
    campaigns: repos.campaigns,
    events: repos.events,
  };

  const agentWorker = createAgentWorker(
    buildAgentProcessor(runner, {
      ga4PollDeps,
      marketingInputDeps,
      googleServiceAccountJson: options.googleServiceAccountJson ?? null,
    }),
    connection,
  );
  await agentWorker.waitUntilReady();

  const approvalExecutorWorker = createApprovalExecutorWorker(
    buildApprovalExecutor({ db, approvals: repos.approvals, events: repos.events }),
    connection,
  );
  await approvalExecutorWorker.waitUntilReady();

  if (options.defaultWorkspaceId) {
    await scheduleRecurringAgents(queues.agents, options.defaultWorkspaceId);
  }

  return {
    queues,
    normalizationWorker,
    dlqWorker,
    agentWorker,
    approvalExecutorWorker,
    async close() {
      await normalizationWorker.close();
      await dlqWorker.close();
      await agentWorker.close();
      await approvalExecutorWorker.close();
      await queues.close();
      connection.disconnect();
    },
  };
}

interface MarketingProcessorDeps {
  ga4PollDeps: Parameters<typeof runGa4Poll>[0];
  marketingInputDeps: Parameters<typeof buildMarketingAnalystInput>[0];
  googleServiceAccountJson: string | null;
}

function buildAgentProcessor(runner: AgentRunner, mkt: MarketingProcessorDeps) {
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
      case "marketing_analyst": {
        // Hourly cron: poll GA4 first to refresh canonical events, then
        // build agent input from those rows. The poll is idempotent so
        // hourly re-runs cost nothing extra at the DB layer.
        await runGa4Poll(mkt.ga4PollDeps, {
          workspaceId: data.workspace_id,
          serviceAccountJson: mkt.googleServiceAccountJson,
        });
        const input: MarketingAnalystInput = await buildMarketingAnalystInput(
          mkt.marketingInputDeps,
          data.workspace_id,
        );
        return runner.run(new MarketingAnalystAgent(input), {
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
  events: EventRepository;
}

/**
 * Sprint-6 stub. The executor receives an approval id after a human has
 * approved it; it logs an audit event so the timeline is complete. Sprint 7
 * wires the real side effects (Resend send, CRM write, etc.).
 */
function buildApprovalExecutor(deps: ApprovalExecutorDeps) {
  return async (job: Job<ApprovalExecutorJobData>) => {
    const { approval_id, workspace_id } = job.data;
    await withTenant(deps.db, workspace_id, async (tx) => {
      const approval = await deps.approvals.findById(tx, approval_id);
      if (!approval) return;
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
          note: "Sprint 6 stub — Sprint 7 will execute the approved side effect.",
        },
      });
    });
  };
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
    organizations: new OrganizationRepository(),
    leads: new LeadRepository(),
    summaries: new SummaryRepository(),
    threads: new ThreadRepository(),
    campaigns: new CampaignRepository(),
  };
}
