import { describe, expect, it, vi } from "vitest";
import { AgentRunner } from "./agent-runner.js";
import type { IAgent } from "./agents/types.js";
import type { Db, Tx } from "@vex/db";
import type { ProposedAction } from "@vex/integrations";

function makeFakeTx(): Tx {
  return { execute: vi.fn(async () => undefined) } as unknown as Tx;
}

interface FakeAgentRunRow {
  id: string;
  status: string;
}

function buildDeps(workspaceSettings: {
  enabled_agents: string[];
  kill_all_agents: boolean;
}) {
  const tx = makeFakeTx();
  const auditCalls: { verb: string; metadata: Record<string, unknown> }[] = [];
  const agentRunCalls: { method: string; args: unknown[] }[] = [];
  const approvalCalls: { method: string; args: unknown[] }[] = [];

  const fakeRun: FakeAgentRunRow = { id: "run-1", status: "pending" };

  const db = {
    transaction: async <T>(cb: (t: Tx) => Promise<T>) => cb(tx),
  } as unknown as Db;

  return {
    tx,
    auditCalls,
    agentRunCalls,
    approvalCalls,
    deps: {
      db,
      workspaces: {
        findById: vi.fn(async () => ({
          id: "ws-1",
          name: "Acme",
          plan: "pro",
          settings: {
            source_priority: [],
            enabled_agents: workspaceSettings.enabled_agents,
            daily_cost_limit: 100,
            kill_all_agents: workspaceSettings.kill_all_agents,
          },
          createdAt: new Date(),
          updatedAt: new Date(),
        })),
        getSettings: vi.fn(),
      } as never,
      agentRuns: {
        create: vi.fn(async (..._args: unknown[]) => {
          agentRunCalls.push({ method: "create", args: _args });
          return fakeRun;
        }),
        markRunning: vi.fn(async (..._args: unknown[]) => {
          agentRunCalls.push({ method: "markRunning", args: _args });
        }),
        complete: vi.fn(async (..._args: unknown[]) => {
          agentRunCalls.push({ method: "complete", args: _args });
        }),
        findById: vi.fn(),
        findByName: vi.fn(),
      } as never,
      approvals: {
        create: vi.fn(async (..._args: unknown[]) => {
          approvalCalls.push({ method: "create", args: _args });
          return { id: `approval-${approvalCalls.length}`, decision: "pending" };
        }),
        findById: vi.fn(),
        listByDecision: vi.fn(),
        decide: vi.fn(),
      } as never,
      organizations: {} as never,
      contacts: {} as never,
      leads: {} as never,
      summaries: {} as never,
      touchpoints: {} as never,
      activities: {} as never,
      threads: {} as never,
      events: {
        insertIfNotExists: vi.fn(async (_tx: Tx, _tenantId: string, data: unknown) => {
          const d = data as { verb: string; metadata?: Record<string, unknown> };
          auditCalls.push({ verb: d.verb, metadata: d.metadata ?? {} });
          return { event: { id: "evt", verb: d.verb }, isNew: true };
        }),
      } as never,
      anthropic: {} as never,
      openai: {} as never,
      costLedger: {} as never,
      retrieval: {} as never,
    },
  };
}

class FakeAgent implements IAgent {
  constructor(
    public readonly name: string,
    public readonly tier: IAgent["tier"],
    private readonly output: {
      costUsd?: number;
      proposedActions?: ProposedAction[];
      internalWrites?: number;
      throws?: string;
    } = {},
  ) {}
  async run() {
    if (this.output.throws) throw new Error(this.output.throws);
    return {
      costUsd: this.output.costUsd ?? 0,
      outputRefs: { ok: true },
      proposedActions: this.output.proposedActions ?? [],
      internalWrites: this.output.internalWrites ?? 0,
    };
  }
}

describe("AgentRunner.run", () => {
  it("skips an agent that's not in enabled_agents — never opens a tx", async () => {
    const fixture = buildDeps({ enabled_agents: ["other"], kill_all_agents: false });
    const runner = new AgentRunner(fixture.deps);
    const record = await runner.run(new FakeAgent("daily_brief", "T0"), {
      workspaceId: "ws-1",
    });
    expect(record.status).toBe("skipped_disabled");
    expect(record.agentRunId).toBeNull();
    expect(fixture.agentRunCalls).toHaveLength(0);
    expect(fixture.auditCalls).toHaveLength(0);
  });

  it("respects kill_all_agents for T1+ but lets T0 through", async () => {
    const enabled = { enabled_agents: ["daily_brief", "follow_up"], kill_all_agents: true };
    {
      const fixture = buildDeps(enabled);
      const runner = new AgentRunner(fixture.deps);
      const record = await runner.run(new FakeAgent("follow_up", "T1"), {
        workspaceId: "ws-1",
      });
      expect(record.status).toBe("skipped_kill_switch");
      expect(fixture.agentRunCalls).toHaveLength(0);
    }
    {
      const fixture = buildDeps(enabled);
      const runner = new AgentRunner(fixture.deps);
      const record = await runner.run(new FakeAgent("daily_brief", "T0"), {
        workspaceId: "ws-1",
      });
      expect(record.status).toBe("completed");
    }
  });

  it("routes T2+ proposed actions through ApprovalGate (creates approval rows)", async () => {
    const fixture = buildDeps({ enabled_agents: ["sender"], kill_all_agents: false });
    const runner = new AgentRunner(fixture.deps);
    await runner.run(
      new FakeAgent("sender", "T2", {
        proposedActions: [
          {
            kind: "email.send",
            tier: "T2",
            payload: { to: "buyer@example.test", subject: "Hi" },
          },
        ],
      }),
      { workspaceId: "ws-1" },
    );
    expect(fixture.approvalCalls.filter((c) => c.method === "create")).toHaveLength(1);
    expect(fixture.auditCalls.map((c) => c.verb)).toContain("approval.created");
    expect(fixture.auditCalls.map((c) => c.verb)).toContain("agent.completed");
  });

  it("does NOT create approvals for T0/T1 actions — those run inline", async () => {
    const fixture = buildDeps({ enabled_agents: ["noter"], kill_all_agents: false });
    const runner = new AgentRunner(fixture.deps);
    await runner.run(
      new FakeAgent("noter", "T1", {
        proposedActions: [
          {
            kind: "crm.note",
            tier: "T1",
            payload: { body: "internal note" },
          },
        ],
      }),
      { workspaceId: "ws-1" },
    );
    expect(fixture.approvalCalls.filter((c) => c.method === "create")).toHaveLength(0);
  });

  it("captures agent throws as status=failed without re-throwing", async () => {
    const fixture = buildDeps({ enabled_agents: ["broken"], kill_all_agents: false });
    const runner = new AgentRunner(fixture.deps);
    const record = await runner.run(
      new FakeAgent("broken", "T0", { throws: "boom" }),
      { workspaceId: "ws-1" },
    );
    expect(record.status).toBe("failed");
    expect(record.error).toBe("boom");
    expect(fixture.auditCalls.map((c) => c.verb)).toContain("agent.failed");
  });
});
