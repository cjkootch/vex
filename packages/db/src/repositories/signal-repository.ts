import { and, desc, eq, isNull, sql } from "drizzle-orm";
import { createId } from "@vex/domain";
import type { Tx } from "../client.js";
import { signals, type Signal } from "../schema/signals.js";

export interface SignalFire {
  ruleId: string;
  severity?: "info" | "warn" | "critical";
  subjectType?: string | null;
  subjectId?: string | null;
  title: string;
  body?: string | null;
  metadata?: Record<string, unknown>;
}

export class SignalRepository {
  /**
   * Fire a signal idempotently. Returns the existing open row when
   * (tenant, rule_id, subject_id) already has an unacknowledged
   * signal; inserts otherwise. Callers don't need to track rule
   * state between ticks — re-firing the same rule on the same
   * subject is a no-op until the operator acknowledges.
   */
  async fire(tx: Tx, tenantId: string, data: SignalFire): Promise<Signal> {
    const existing = await tx
      .select()
      .from(signals)
      .where(
        and(
          eq(signals.tenantId, tenantId),
          eq(signals.ruleId, data.ruleId),
          sql`coalesce(${signals.subjectId}, '') = ${data.subjectId ?? ""}`,
          isNull(signals.acknowledgedAt),
        ),
      )
      .limit(1);
    if (existing[0]) return existing[0];
    const [row] = await tx
      .insert(signals)
      .values({
        id: createId(),
        tenantId,
        ruleId: data.ruleId,
        severity: data.severity ?? "warn",
        subjectType: data.subjectType ?? null,
        subjectId: data.subjectId ?? null,
        title: data.title,
        body: data.body ?? null,
        metadata: data.metadata ?? {},
      })
      .returning();
    if (!row) throw new Error("signal insert returned no row");
    return row;
  }

  async listOpen(
    tx: Tx,
    limit = 100,
    subject?: { subjectType: string; subjectId: string },
  ): Promise<Signal[]> {
    const clauses = [isNull(signals.acknowledgedAt)];
    if (subject) {
      clauses.push(eq(signals.subjectType, subject.subjectType));
      clauses.push(eq(signals.subjectId, subject.subjectId));
    }
    return tx
      .select()
      .from(signals)
      .where(and(...clauses))
      .orderBy(desc(signals.createdAt))
      .limit(limit);
  }

  async listRecent(
    tx: Tx,
    limit = 100,
    subject?: { subjectType: string; subjectId: string },
  ): Promise<Signal[]> {
    const clauses = [] as ReturnType<typeof eq>[];
    if (subject) {
      clauses.push(eq(signals.subjectType, subject.subjectType));
      clauses.push(eq(signals.subjectId, subject.subjectId));
    }
    const base = tx.select().from(signals);
    const filtered = clauses.length > 0 ? base.where(and(...clauses)) : base;
    return filtered.orderBy(desc(signals.createdAt)).limit(limit);
  }

  async acknowledge(
    tx: Tx,
    id: string,
    by: string,
  ): Promise<Signal | null> {
    const [row] = await tx
      .update(signals)
      .set({ acknowledgedAt: new Date(), acknowledgedBy: by })
      .where(and(eq(signals.id, id), isNull(signals.acknowledgedAt)))
      .returning();
    return row ?? null;
  }

  /**
   * Close any open signal for a (rule, subject) pair — used when a
   * rule detects the underlying condition has resolved (e.g. BIS
   * licence arrived, so clear the "missing BIS" signal for that
   * deal). Silent no-op if no matching open row exists.
   */
  async resolve(
    tx: Tx,
    tenantId: string,
    ruleId: string,
    subjectId: string | null,
  ): Promise<void> {
    await tx
      .update(signals)
      .set({
        acknowledgedAt: new Date(),
        acknowledgedBy: "system.resolved",
      })
      .where(
        and(
          eq(signals.tenantId, tenantId),
          eq(signals.ruleId, ruleId),
          sql`coalesce(${signals.subjectId}, '') = ${subjectId ?? ""}`,
          isNull(signals.acknowledgedAt),
        ),
      );
  }
}
