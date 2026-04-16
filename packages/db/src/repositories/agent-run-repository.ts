import { and, eq } from "drizzle-orm";
import { createId } from "@vex/domain";
import type { Tx } from "../client.js";
import { agentRuns, type AgentRun } from "../schema/agent-runs.js";

export type AgentRunStatus = "pending" | "running" | "completed" | "failed";

export interface AgentRunCreate {
  agentName: string;
  inputRefs?: Record<string, unknown>;
}

export interface AgentRunComplete {
  status: "completed" | "failed";
  costUsd: number;
  outputRefs?: Record<string, unknown>;
  error?: string | null;
}

/**
 * Lifecycle helpers for `agent_runs`. `AgentRunner` calls `create` →
 * `markRunning` → `complete` (or `markFailed`) for every run; the rows
 * also carry the cost roll-up so the dashboard can show $/agent.
 */
export class AgentRunRepository {
  async create(tx: Tx, tenantId: string, data: AgentRunCreate): Promise<AgentRun> {
    const [row] = await tx
      .insert(agentRuns)
      .values({
        id: createId(),
        tenantId,
        agentName: data.agentName,
        status: "pending",
        inputRefs: data.inputRefs ?? {},
      })
      .returning();
    if (!row) throw new Error("agent_run insert returned no row");
    return row;
  }

  async markRunning(tx: Tx, id: string): Promise<void> {
    await tx
      .update(agentRuns)
      .set({ status: "running", startedAt: new Date() })
      .where(eq(agentRuns.id, id));
  }

  async complete(tx: Tx, id: string, data: AgentRunComplete): Promise<void> {
    await tx
      .update(agentRuns)
      .set({
        status: data.status,
        finishedAt: new Date(),
        costUsd: data.costUsd,
        outputRefs: data.outputRefs ?? {},
        error: data.error ?? null,
      })
      .where(eq(agentRuns.id, id));
  }

  async findById(tx: Tx, id: string): Promise<AgentRun | null> {
    const rows = await tx.select().from(agentRuns).where(eq(agentRuns.id, id));
    return rows[0] ?? null;
  }

  async findByName(tx: Tx, agentName: string, limit = 50): Promise<AgentRun[]> {
    return tx
      .select()
      .from(agentRuns)
      .where(and(eq(agentRuns.agentName, agentName)))
      .limit(limit);
  }
}
