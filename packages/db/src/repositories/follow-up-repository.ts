import { and, asc, eq, lte } from "drizzle-orm";
import { createId } from "@vex/domain";
import type { Tx } from "../client.js";
import { followUps, type FollowUp } from "../schema/follow-ups.js";

export interface FollowUpCreate {
  title: string;
  note?: string | null;
  dueAt: Date;
  subjectType?: string | null;
  subjectId?: string | null;
  assignedTo?: string | null;
  createdBy: string;
}

export class FollowUpRepository {
  async insert(tx: Tx, tenantId: string, data: FollowUpCreate): Promise<FollowUp> {
    const [row] = await tx
      .insert(followUps)
      .values({
        id: createId(),
        tenantId,
        title: data.title,
        note: data.note ?? null,
        dueAt: data.dueAt,
        subjectType: data.subjectType ?? null,
        subjectId: data.subjectId ?? null,
        assignedTo: data.assignedTo ?? null,
        createdBy: data.createdBy,
      })
      .returning();
    if (!row) throw new Error("follow_up insert returned no row");
    return row;
  }

  async findById(tx: Tx, id: string): Promise<FollowUp | null> {
    const rows = await tx
      .select()
      .from(followUps)
      .where(eq(followUps.id, id))
      .limit(1);
    return rows[0] ?? null;
  }

  /** Open follow-ups sorted by due_at ascending. */
  async listOpen(tx: Tx, limit = 100): Promise<FollowUp[]> {
    return tx
      .select()
      .from(followUps)
      .where(eq(followUps.status, "open"))
      .orderBy(asc(followUps.dueAt))
      .limit(limit);
  }

  /**
   * Open follow-ups for a specific subject. Used by
   * retrieval to surface "you have a follow-up scheduled for Acme
   * next Thursday" evidence.
   */
  async listOpenForSubject(
    tx: Tx,
    subjectType: string,
    subjectId: string,
    limit = 20,
  ): Promise<FollowUp[]> {
    return tx
      .select()
      .from(followUps)
      .where(
        and(
          eq(followUps.status, "open"),
          eq(followUps.subjectType, subjectType),
          eq(followUps.subjectId, subjectId),
        ),
      )
      .orderBy(asc(followUps.dueAt))
      .limit(limit);
  }

  /** Open follow-ups due before `before`. Used by cron notifiers. */
  async listDueBefore(tx: Tx, before: Date, limit = 200): Promise<FollowUp[]> {
    return tx
      .select()
      .from(followUps)
      .where(and(eq(followUps.status, "open"), lte(followUps.dueAt, before)))
      .orderBy(asc(followUps.dueAt))
      .limit(limit);
  }

  async markCompleted(tx: Tx, id: string): Promise<FollowUp> {
    const [row] = await tx
      .update(followUps)
      .set({
        status: "completed",
        completedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(and(eq(followUps.id, id), eq(followUps.status, "open")))
      .returning();
    if (!row) throw new Error(`follow_up ${id} not found or already closed`);
    return row;
  }

  async markCancelled(tx: Tx, id: string): Promise<FollowUp> {
    const [row] = await tx
      .update(followUps)
      .set({
        status: "cancelled",
        completedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(and(eq(followUps.id, id), eq(followUps.status, "open")))
      .returning();
    if (!row) throw new Error(`follow_up ${id} not found or already closed`);
    return row;
  }

  /** Hydration helper for retrieval. Limited scan, tenant-scoped by RLS. */
  async listOpenAnyInTenant(tx: Tx, limit = 50): Promise<FollowUp[]> {
    return tx
      .select()
      .from(followUps)
      .where(eq(followUps.status, "open"))
      .orderBy(asc(followUps.dueAt))
      .limit(limit);
  }

}
