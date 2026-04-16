import { and, desc, eq } from "drizzle-orm";
import { createId } from "@vex/domain";
import type { Tx } from "../client.js";
import { summaries, type NewSummary, type Summary } from "../schema/summaries.js";

export interface SummaryUpsertData {
  subjectType: string;
  subjectId: string;
  summaryType: string;
  content: string;
  validityWindowStart?: Date | null;
  validityWindowEnd?: Date | null;
}

/** Stateless. Caller must wrap in `withTenant`. */
export class SummaryRepository {
  async getLatest(
    tx: Tx,
    subjectType: string,
    subjectId: string,
    summaryType: string,
  ): Promise<Summary | null> {
    const [row] = await tx
      .select()
      .from(summaries)
      .where(
        and(
          eq(summaries.subjectType, subjectType),
          eq(summaries.subjectId, subjectId),
          eq(summaries.summaryType, summaryType),
        ),
      )
      .orderBy(desc(summaries.version))
      .limit(1);
    return row ?? null;
  }

  /**
   * Upsert a summary by bumping its version. Never mutates historical rows —
   * every upsert appends a new version so we can reconstruct past views.
   */
  async upsert(tx: Tx, tenantId: string, data: SummaryUpsertData): Promise<Summary> {
    const latest = await this.getLatest(
      tx,
      data.subjectType,
      data.subjectId,
      data.summaryType,
    );
    const nextVersion = latest ? latest.version + 1 : 1;

    const insert: NewSummary = {
      id: createId(),
      tenantId,
      subjectType: data.subjectType,
      subjectId: data.subjectId,
      summaryType: data.summaryType,
      version: nextVersion,
      content: data.content,
      validityWindowStart: data.validityWindowStart ?? null,
      validityWindowEnd: data.validityWindowEnd ?? null,
    };

    const [inserted] = await tx.insert(summaries).values(insert).returning();
    if (!inserted) throw new Error("summary insert returned no row");
    return inserted;
  }

  async listBySubject(
    tx: Tx,
    subjectType: string,
    subjectId: string,
  ): Promise<Summary[]> {
    return tx
      .select()
      .from(summaries)
      .where(
        and(eq(summaries.subjectType, subjectType), eq(summaries.subjectId, subjectId)),
      )
      .orderBy(desc(summaries.createdAt));
  }
}
