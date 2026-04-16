import { and, desc, eq } from "drizzle-orm";
import { createId } from "@vex/domain";
import type { Tx } from "../client.js";
import { approvals, type Approval } from "../schema/approvals.js";

export type ApprovalDecision = "pending" | "approved" | "rejected" | "auto_approved";

export interface ApprovalCreate {
  agentRunId?: string | null;
  actionType: string;
  proposedPayload: Record<string, unknown>;
}

export class ApprovalRepository {
  async create(tx: Tx, tenantId: string, data: ApprovalCreate): Promise<Approval> {
    const [row] = await tx
      .insert(approvals)
      .values({
        id: createId(),
        tenantId,
        agentRunId: data.agentRunId ?? null,
        actionType: data.actionType,
        proposedPayload: data.proposedPayload,
        decision: "pending",
      })
      .returning();
    if (!row) throw new Error("approval insert returned no row");
    return row;
  }

  async findById(tx: Tx, id: string): Promise<Approval | null> {
    const rows = await tx.select().from(approvals).where(eq(approvals.id, id));
    return rows[0] ?? null;
  }

  async listByDecision(
    tx: Tx,
    decision: ApprovalDecision,
    limit = 50,
  ): Promise<Approval[]> {
    return tx
      .select()
      .from(approvals)
      .where(eq(approvals.decision, decision))
      .orderBy(desc(approvals.createdAt))
      .limit(limit);
  }

  async decide(
    tx: Tx,
    id: string,
    decision: Exclude<ApprovalDecision, "pending">,
    reviewerId: string | null,
  ): Promise<Approval> {
    const [row] = await tx
      .update(approvals)
      .set({
        decision,
        decidedAt: new Date(),
        reviewerId,
      })
      .where(and(eq(approvals.id, id), eq(approvals.decision, "pending")))
      .returning();
    if (!row) {
      throw new Error(
        `approval ${id} could not be decided — already decided or not found`,
      );
    }
    return row;
  }
}
