import { NativeConnection, Worker as TemporalWorker } from "@temporalio/worker";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import {
  ActivityRepository,
  AgentRunRepository,
  ApprovalRepository,
  CampaignEnrollmentRepository,
  CampaignStepRepository,
  ContactRepository,
  EventRepository,
  LeadRepository,
  OrganizationRepository,
  SummaryRepository,
  ThreadRepository,
  TouchpointRepository,
  WorkspaceRepository,
  type Db,
} from "@vex/db";
import type {
  AnthropicAdapter,
  S3Uploader,
  TwilioClient,
} from "@vex/integrations";
import type { CostLedger } from "@vex/telemetry";
import { buildFollowUpActivities } from "./activities/follow-up-activities.js";
import { buildResearchActivities } from "./activities/research-activities.js";
import { buildCallActivities } from "./activities/call-activities.js";
import { buildEnrollmentActivities } from "./activities/enrollment-activities.js";

export interface OutboundCallConfig {
  /** Public URL Twilio hits for the TwiML document driving the call. */
  twimlUrl: string;
  /** Public URL Twilio POSTs call-lifecycle status updates to. */
  statusCallbackUrl: string;
  /** Public URL Twilio POSTs recording-completion callbacks to. */
  recordingCallbackUrl: string;
}

export interface TemporalRunnerOptions {
  address: string;
  namespace: string;
  taskQueue: string;
  /**
   * Optional Temporal Cloud API key. When set, NativeConnection.connect
   * uses TLS + Bearer-token auth. Unset for local temporalite.
   */
  apiKey?: string | undefined;
  db: Db;
  anthropic: AnthropicAdapter;
  costLedger: CostLedger;
  /** Sprint 12 — optional. When omitted the call activities are skipped. */
  twilio?: TwilioClient;
  s3?: S3Uploader;
  outboundCall?: OutboundCallConfig;
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
  const connection = await NativeConnection.connect({
    address: options.address,
    ...(options.apiKey
      ? {
          tls: true,
          apiKey: options.apiKey,
          metadata: { "temporal-namespace": options.namespace },
        }
      : {}),
  });

  const repos = {
    organizations: new OrganizationRepository(),
    contacts: new ContactRepository(),
    touchpoints: new TouchpointRepository(),
    activities: new ActivityRepository(),
    leads: new LeadRepository(),
    threads: new ThreadRepository(),
    summaries: new SummaryRepository(),
    events: new EventRepository(),
    approvals: new ApprovalRepository(),
    agentRuns: new AgentRunRepository(),
    campaignSteps: new CampaignStepRepository(),
    campaignEnrollments: new CampaignEnrollmentRepository(),
    workspaces: new WorkspaceRepository(),
  };

  const followUpActivities = buildFollowUpActivities({
    db: options.db,
    threads: repos.threads,
    leads: repos.leads,
    approvals: repos.approvals,
    events: repos.events,
    anthropic: options.anthropic,
  });

  const enrollmentActivities = buildEnrollmentActivities({
    db: options.db,
    enrollments: repos.campaignEnrollments,
    steps: repos.campaignSteps,
    approvals: repos.approvals,
    touchpoints: repos.touchpoints,
    contacts: repos.contacts,
    organizations: repos.organizations,
    events: repos.events,
    workspaces: repos.workspaces,
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

  // Sprint 12 — call activities are only wired when the Twilio / S3 /
  // URL-config bundle is supplied. Otherwise the worker still runs the
  // follow-up and research workflows cleanly and the OutboundCallWorkflow
  // attempts just fail closed at the first activity call.
  const callActivities =
    options.twilio && options.s3 && options.outboundCall
      ? buildCallActivities({
          db: options.db,
          contacts: repos.contacts,
          approvals: repos.approvals,
          activities: repos.activities,
          touchpoints: repos.touchpoints,
          summaries: repos.summaries,
          events: repos.events,
          twilio: options.twilio,
          anthropic: options.anthropic,
          s3: options.s3,
          twimlUrl: options.outboundCall.twimlUrl,
          statusCallbackUrl: options.outboundCall.statusCallbackUrl,
          recordingCallbackUrl: options.outboundCall.recordingCallbackUrl,
        })
      : {};

  const here = dirname(fileURLToPath(import.meta.url));
  const worker = await TemporalWorker.create({
    connection,
    namespace: options.namespace,
    taskQueue: options.taskQueue,
    workflowsPath: resolve(here, "./workflows/index.js"),
    activities: {
      ...followUpActivities,
      ...researchActivities,
      ...callActivities,
      ...enrollmentActivities,
    },
  });

  void worker.run();
  return worker;
}
