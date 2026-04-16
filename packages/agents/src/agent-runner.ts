import { createId } from "@vex/domain";
import {
  withTenant,
  type ActivityRepository,
  type AgentRunRepository,
  type ApprovalRepository,
  type ContactRepository,
  type Db,
  type EventRepository,
  type LeadRepository,
  type OrganizationRepository,
  type RetrievalService,
  type SummaryRepository,
  type ThreadRepository,
  type TouchpointRepository,
  type WorkspaceRepository,
} from "@vex/db";
import type { AnthropicAdapter, OpenAIAdapter } from "@vex/integrations";
import type { CostLedger } from "@vex/telemetry";
import { ApprovalGate } from "./approval-gate.js";
import type { AgentContext, AgentOutput, IAgent } from "./agents/types.js";

/**
 * What `run()` returns to the caller. Captures the actual `agent_run` row
 * id (or null if the run was skipped by a flag/kill switch) plus the
 * outcome so callers can react.
 */
export interface AgentRunRecord {
  agentRunId: string | null;
  status: "skipped_disabled" | "skipped_kill_switch" | "completed" | "failed";
  costUsd: number;
  approvalsCreated: number;
  internalWrites: number;
  rationale?: string;
  error?: string;
}

export interface AgentRunnerDeps {
  db: Db;
  workspaces: WorkspaceRepository;
  agentRuns: AgentRunRepository;
  approvals: ApprovalRepository;
  organizations: OrganizationRepository;
  contacts: ContactRepository;
  leads: LeadRepository;
  summaries: SummaryRepository;
  touchpoints: TouchpointRepository;
  activities: ActivityRepository;
  threads: ThreadRepository;
  events: EventRepository;
  anthropic: AnthropicAdapter;
  openai: OpenAIAdapter;
  costLedger: CostLedger;
  retrieval: RetrievalService;
}

export interface AgentRunRequest {
  workspaceId: string;
  /** Defaults to workspaceId when tenantId == workspaceId (the common case). */
  tenantId?: string;
}

/**
 * Orchestrates a single agent invocation:
 *
 *   1. Pre-checks the workspace's `enabled_agents` flag — never burns
 *      tokens on a disabled agent.
 *   2. Pre-checks `kill_all_agents` — T1+ are skipped when the kill
 *      switch is on.
 *   3. Opens `withTenant`, creates the `agent_run` row (status=pending).
 *   4. Marks running, calls `agent.run(ctx)` inside try/catch.
 *   5. Routes T2+ proposed actions through {@link ApprovalGate} — never
 *      executes them inline.
 *   6. Marks completed/failed, writes audit `events`, returns the record.
 */
export class AgentRunner {
  private readonly gate = new ApprovalGate();

  constructor(private readonly deps: AgentRunnerDeps) {}

  async run(agent: IAgent, request: AgentRunRequest): Promise<AgentRunRecord> {
    const tenantId = request.tenantId ?? request.workspaceId;
    const workspace = await this.deps.workspaces.findById(this.deps.db, request.workspaceId);
    if (!workspace) {
      return {
        agentRunId: null,
        status: "failed",
        costUsd: 0,
        approvalsCreated: 0,
        internalWrites: 0,
        error: `workspace ${request.workspaceId} not found`,
      };
    }

    if (!workspace.settings.enabled_agents.includes(agent.name)) {
      return {
        agentRunId: null,
        status: "skipped_disabled",
        costUsd: 0,
        approvalsCreated: 0,
        internalWrites: 0,
        rationale: `agent ${agent.name} not in enabled_agents`,
      };
    }

    if (workspace.settings.kill_all_agents && agent.tier !== "T0") {
      return {
        agentRunId: null,
        status: "skipped_kill_switch",
        costUsd: 0,
        approvalsCreated: 0,
        internalWrites: 0,
        rationale: `kill_all_agents is on; ${agent.name} is ${agent.tier}`,
      };
    }

    return withTenant(this.deps.db, tenantId, async (tx) => {
      const run = await this.deps.agentRuns.create(tx, tenantId, {
        agentName: agent.name,
        inputRefs: { workspaceId: request.workspaceId },
      });
      await this.deps.agentRuns.markRunning(tx, run.id);

      const ctx: AgentContext = {
        tenantId,
        workspaceId: request.workspaceId,
        agentRunId: run.id,
        tx,
        anthropic: this.deps.anthropic,
        openai: this.deps.openai,
        costLedger: this.deps.costLedger,
        retrieval: this.deps.retrieval,
        organizations: this.deps.organizations,
        contacts: this.deps.contacts,
        leads: this.deps.leads,
        summaries: this.deps.summaries,
        touchpoints: this.deps.touchpoints,
        activities: this.deps.activities,
        threads: this.deps.threads,
        events: this.deps.events,
        approvals: this.deps.approvals,
        agentRuns: this.deps.agentRuns,
        workspaces: this.deps.workspaces,
      };

      let output: AgentOutput;
      try {
        output = await agent.run(ctx);
      } catch (err) {
        const message = (err as Error).message ?? "unknown agent failure";
        await this.deps.agentRuns.complete(tx, run.id, {
          status: "failed",
          costUsd: 0,
          error: message,
        });
        await this.emitAudit(ctx, agent, run.id, "agent.failed", { error: message });
        return {
          agentRunId: run.id,
          status: "failed",
          costUsd: 0,
          approvalsCreated: 0,
          internalWrites: 0,
          error: message,
        } satisfies AgentRunRecord;
      }

      // Route any T2+ proposed actions through the approval gate. T0/T1
      // proposed actions land in `output_refs` so the dashboard can show
      // what the agent did without creating an approval row.
      let approvalsCreated = 0;
      const gatedRefs: { approval_id: string; kind: string; tier: string }[] = [];
      for (const action of output.proposedActions) {
        if (action.tier === "T2" || action.tier === "T3") {
          const approval = await this.gate.create(ctx, action, run.id);
          approvalsCreated++;
          gatedRefs.push({ approval_id: approval.id, kind: action.kind, tier: action.tier });
        }
      }

      await this.deps.agentRuns.complete(tx, run.id, {
        status: "completed",
        costUsd: output.costUsd,
        outputRefs: {
          ...output.outputRefs,
          approvals: gatedRefs,
          internal_writes: output.internalWrites,
        },
      });

      await this.emitAudit(ctx, agent, run.id, "agent.completed", {
        cost_usd: output.costUsd,
        approvals_created: approvalsCreated,
        internal_writes: output.internalWrites,
      });

      const record: AgentRunRecord = {
        agentRunId: run.id,
        status: "completed",
        costUsd: output.costUsd,
        approvalsCreated,
        internalWrites: output.internalWrites,
      };
      if (output.rationale !== undefined) record.rationale = output.rationale;
      return record;
    });
  }

  private async emitAudit(
    ctx: AgentContext,
    agent: IAgent,
    agentRunId: string,
    verb: string,
    metadata: Record<string, unknown>,
  ): Promise<void> {
    const occurredAt = new Date();
    await ctx.events.insertIfNotExists(ctx.tx, ctx.tenantId, {
      verb,
      subjectType: "agent_run",
      subjectId: agentRunId,
      actorType: "system",
      actorId: agent.name,
      objectType: "agent",
      objectId: agent.name,
      occurredAt,
      idempotencyKey: `${verb}:${agentRunId}`,
      metadata: { ...metadata, audit_event_id: createId() },
    });
  }
}
