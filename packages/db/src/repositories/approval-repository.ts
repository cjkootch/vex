import { and, desc, eq, inArray, sql } from "drizzle-orm";
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

  /**
   * Find the approval row whose `proposed_payload.workflow_id` matches.
   * Sprint 12 — used by the OutboundCallWorkflow's createApprovalRow
   * activity to stay idempotent across Temporal retries. Reads via a
   * `->>` JSONB extract so the index-less path is acceptable for the
   * single-row check; under sustained load we'd add a functional
   * index on `(proposed_payload ->> 'workflow_id')`.
   */
  async findByWorkflowId(
    tx: Tx,
    workflowId: string,
  ): Promise<Approval | null> {
    const rows = await tx
      .select()
      .from(approvals)
      .where(
        sql`${approvals.proposedPayload} ->> 'workflow_id' = ${workflowId}`,
      )
      .orderBy(desc(approvals.createdAt))
      .limit(1);
    return rows[0] ?? null;
  }

  /**
   * Stamp the approval as applied — writes the created/modified object's
   * id and the current timestamp. Callers MUST write inside the same
   * tenant-scoped tx that performs the create, so a crash between the
   * insert and the mark rolls the whole thing back and the retry sees
   * a still-unapplied approval. Idempotent: a second call with the same
   * object id is a noop because the WHERE guards on applied_object_id.
   */
  async markApplied(
    tx: Tx,
    id: string,
    appliedObjectId: string,
  ): Promise<void> {
    await tx
      .update(approvals)
      .set({ appliedObjectId, appliedAt: new Date() })
      .where(
        and(
          eq(approvals.id, id),
          sql`${approvals.appliedObjectId} IS NULL`,
        ),
      );
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

  /**
   * Batch-decide a set of pending approvals in a single SQL UPDATE.
   * Only rows still in `pending` are touched; already-decided rows are
   * silently skipped so a retry is safe. Returns the rows that were
   * actually decided — caller diffs against the input to know which
   * ids were skipped.
   */
  async bulkDecide(
    tx: Tx,
    ids: string[],
    decision: Exclude<ApprovalDecision, "pending">,
    reviewerId: string | null,
  ): Promise<Approval[]> {
    if (ids.length === 0) return [];
    return tx
      .update(approvals)
      .set({
        decision,
        decidedAt: new Date(),
        reviewerId,
      })
      .where(
        and(inArray(approvals.id, ids), eq(approvals.decision, "pending")),
      )
      .returning();
  }
}
