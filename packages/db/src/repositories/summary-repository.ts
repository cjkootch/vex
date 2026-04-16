import { and, desc, eq } from "drizzle-orm";
import { createId } from "@vex/domain";
import type { Db } from "../client.js";
import { summaries, type NewSummary, type Summary } from "../schema/summaries.js";

export interface SummaryUpsertData {
  subjectType: string;
  subjectId: string;
  summaryType: string;
  content: string;
  validityWindowStart?: Date | null;
  validityWindowEnd?: Date | null;
}

export class SummaryRepository {
  constructor(private readonly db: Db) {}

  async getLatest(
    tenantId: string,
    subjectType: string,
    subjectId: string,
    summaryType: string,
  ): Promise<Summary | null> {
    const [row] = await this.db
      .select()
      .from(summaries)
      .where(
        and(
          eq(summaries.tenantId, tenantId),
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
  async upsert(tenantId: string, data: SummaryUpsertData): Promise<Summary> {
    const latest = await this.getLatest(
      tenantId,
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

    const [inserted] = await this.db.insert(summaries).values(insert).returning();
    if (!inserted) throw new Error("summary insert returned no row");
    return inserted;
  }

  async listBySubject(
    tenantId: string,
    subjectType: string,
    subjectId: string,
  ): Promise<Summary[]> {
    return this.db
      .select()
      .from(summaries)
      .where(
        and(
          eq(summaries.tenantId, tenantId),
          eq(summaries.subjectType, subjectType),
          eq(summaries.subjectId, subjectId),
        ),
      )
      .orderBy(desc(summaries.createdAt));
  }
}
