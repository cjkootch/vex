import {
  addAgentJob,
  type AgentJobData,
} from "@vex/agents";
import { withTenant, type Db, type OrganizationRepository, type WorkspaceRepository } from "@vex/db";
import type { Queue } from "bullmq";

export interface ScannerOptions {
  db: Db;
  agentsQueue: Queue<AgentJobData>;
  workspaces: WorkspaceRepository;
  organizations: OrganizationRepository;
  /** Cap research jobs per scan to avoid token-budget surprises. */
  maxResearchJobsPerScan?: number;
  /** Stale threshold for organisations (default: 7 days). */
  researchStaleAfterDays?: number;
}

export interface ScanReport {
  workspaceId: string;
  enqueued: number;
  skipped: number;
  reason?: string;
}

/**
 * Periodic scanner that fans out ResearchAgent jobs for stale organisations.
 *
 * Runs at worker boot and re-queues itself hourly via the BullMQ scheduler.
 * Respects `enabled_agents` and `kill_all_agents` BEFORE enqueueing so we
 * never burn queue capacity on workspaces that wouldn't run the agent.
 */
export class AgentScanner {
  constructor(private readonly opts: ScannerOptions) {}

  async scan(workspaceId: string): Promise<ScanReport> {
    const ws = await this.opts.workspaces.findById(this.opts.db, workspaceId);
    if (!ws) {
      return { workspaceId, enqueued: 0, skipped: 0, reason: "workspace_not_found" };
    }

    if (!ws.settings.enabled_agents.includes("research")) {
      return { workspaceId, enqueued: 0, skipped: 0, reason: "research_agent_disabled" };
    }
    if (ws.settings.kill_all_agents) {
      return { workspaceId, enqueued: 0, skipped: 0, reason: "kill_switch_on" };
    }

    const olderThan = new Date(
      Date.now() - (this.opts.researchStaleAfterDays ?? 7) * 24 * 60 * 60 * 1000,
    );
    const cap = this.opts.maxResearchJobsPerScan ?? 10;

    const orgs = await withTenant(this.opts.db, workspaceId, async (tx) =>
      this.opts.organizations.listResearchCandidates(tx, olderThan, cap),
    );

    let enqueued = 0;
    for (const org of orgs) {
      // Dedupe key keeps two scans within the staleness window from
      // enqueueing duplicate research for the same org.
      const dedupe = `${org.id}:${dayBucket()}`;
      await addAgentJob(
        this.opts.agentsQueue,
        {
          kind: "research",
          workspace_id: workspaceId,
          input: { organization_id: org.id },
        },
        dedupe,
      );
      enqueued++;
    }

    return { workspaceId, enqueued, skipped: 0 };
  }
}

function dayBucket(): string {
  const d = new Date();
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
}
