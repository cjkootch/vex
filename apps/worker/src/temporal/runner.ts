import { NativeConnection, Worker as TemporalWorker } from "@temporalio/worker";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import {
  AgentRunRepository,
  ApprovalRepository,
  EventRepository,
  LeadRepository,
  OrganizationRepository,
  SummaryRepository,
  ThreadRepository,
  TouchpointRepository,
  type Db,
} from "@vex/db";
import type { AnthropicAdapter, GoogleAdsAdapter } from "@vex/integrations";
import type { CostLedger } from "@vex/telemetry";
import { buildFollowUpActivities } from "./activities/follow-up-activities.js";
import { buildResearchActivities } from "./activities/research-activities.js";
import { buildLeadWonActivities } from "./activities/lead-won-activities.js";

export interface TemporalRunnerOptions {
  address: string;
  namespace: string;
  taskQueue: string;
  db: Db;
  anthropic: AnthropicAdapter;
  costLedger: CostLedger;
  /** Optional — when null, the LeadWon workflow logs and skips. */
  ads?: GoogleAdsAdapter | null;
  defaultConversionActionName?: string | null;
  defaultAdsCustomerId?: string | null;
}

/**
 * Bootstrap the Vex Temporal Worker. Workflows live in `./workflows/` and
 * are bundled separately (sandboxed). Activities are constructed here
 * with full access to repos, adapters, and telemetry — Temporal calls them
 * over the network so any I/O is safe.
 */
export async function startTemporalWorker(
  options: TemporalRunnerOptions,
): Promise<TemporalWorker> {
  const connection = await NativeConnection.connect({ address: options.address });

  const repos = {
    organizations: new OrganizationRepository(),
    contacts: new TouchpointRepository(),
    touchpoints: new TouchpointRepository(),
    leads: new LeadRepository(),
    threads: new ThreadRepository(),
    summaries: new SummaryRepository(),
    events: new EventRepository(),
    approvals: new ApprovalRepository(),
    agentRuns: new AgentRunRepository(),
  };

  const followUpActivities = buildFollowUpActivities({
    db: options.db,
    threads: repos.threads,
    leads: repos.leads,
    approvals: repos.approvals,
    events: repos.events,
    anthropic: options.anthropic,
  });

  const researchActivities = buildResearchActivities({
    db: options.db,
    organizations: repos.organizations,
    touchpoints: repos.touchpoints,
    summaries: repos.summaries,
    events: repos.events,
    agentRuns: repos.agentRuns,
    anthropic: options.anthropic,
    costLedger: options.costLedger,
  });

  const leadWonActivities = buildLeadWonActivities({
    db: options.db,
    leads: repos.leads,
    events: repos.events,
    ads: options.ads ?? null,
    defaultConversionActionName: options.defaultConversionActionName ?? null,
    defaultCustomerId: options.defaultAdsCustomerId ?? null,
  });

  const here = dirname(fileURLToPath(import.meta.url));
  const worker = await TemporalWorker.create({
    connection,
    namespace: options.namespace,
    taskQueue: options.taskQueue,
    workflowsPath: resolve(here, "./workflows/index.js"),
    activities: {
      ...followUpActivities,
      ...researchActivities,
      ...leadWonActivities,
    },
  });

  void worker.run();
  return worker;
}
