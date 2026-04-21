import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { createId } from "@vex/domain";
import type { Tx } from "../client.js";
import {
  ofacScreens,
  type OfacMatchRecord,
  type OfacScreen,
} from "../schema/ofac-screens.js";
import { organizations } from "../schema/organizations.js";

export type OfacScreenStatus =
  | "unscreened"
  | "clear"
  | "potential_match"
  | "confirmed_match"
  | "cleared_by_operator";

export interface OfacScreenInsert {
  orgId: string;
  sdnListDate: string;
  status: OfacScreenStatus;
  highestScore: number;
  matchCount: number;
  matches: OfacMatchRecord[];
  id?: string;
}

export interface OfacScreenClearInput {
  screenId: string;
  clearedBy: string;
  reason: string;
}

export class OfacScreenRepository {
  /**
   * Record a fresh screen run for an organization. Never mutates an
   * existing row — audit trail is append-only.
   */
  async insert(
    tx: Tx,
    tenantId: string,
    data: OfacScreenInsert,
  ): Promise<OfacScreen> {
    const [row] = await tx
      .insert(ofacScreens)
      .values({
        id: data.id ?? createId(),
        tenantId,
        orgId: data.orgId,
        sdnListDate: data.sdnListDate,
        status: data.status,
        highestScore: data.highestScore,
        matchCount: data.matchCount,
        matches: data.matches,
      })
      .returning();
    if (!row) throw new Error("ofac_screens insert returned no row");
    return row;
  }

  /**
   * Write the rolling state onto organizations so the UI can filter /
   * block without joining to the audit table.
   */
  async updateOrgState(
    tx: Tx,
    orgId: string,
    state: {
      status: OfacScreenStatus;
      screenedAt: Date;
      highestScore: number;
    },
  ): Promise<void> {
    await tx
      .update(organizations)
      .set({
        ofacStatus: state.status,
        ofacScreenedAt: state.screenedAt,
        ofacHighestScore: state.highestScore,
        updatedAt: new Date(),
      })
      .where(eq(organizations.id, orgId));
  }

  async latestForOrg(tx: Tx, orgId: string): Promise<OfacScreen | null> {
    const [row] = await tx
      .select()
      .from(ofacScreens)
      .where(eq(ofacScreens.orgId, orgId))
      .orderBy(desc(ofacScreens.screenedAt))
      .limit(1);
    return row ?? null;
  }

  async listByStatus(
    tx: Tx,
    statuses: OfacScreenStatus[],
  ): Promise<OfacScreen[]> {
    if (statuses.length === 0) return [];
    return tx
      .select()
      .from(ofacScreens)
      .where(inArray(ofacScreens.status, statuses))
      .orderBy(desc(ofacScreens.screenedAt));
  }

  async recentRuns(
    tx: Tx,
    limit = 20,
  ): Promise<
    Array<{ screenedAt: Date; orgCount: number; matchCount: number }>
  > {
    // Group by the calendar hour of the run so a batch screen (many
    // rows within seconds) collapses into one row in the audit UI.
    const rows = await tx.execute(sql`
      SELECT
        date_trunc('hour', screened_at) AS bucket,
        COUNT(DISTINCT org_id)          AS org_count,
        SUM(CASE WHEN status IN ('potential_match','confirmed_match') THEN 1 ELSE 0 END) AS match_count
      FROM ofac_screens
      WHERE tenant_id = current_setting('app.tenant_id', true)
      GROUP BY bucket
      ORDER BY bucket DESC
      LIMIT ${limit}
    `);
    const items = (rows as unknown as {
      rows: Array<{ bucket: Date | string; org_count: number | string; match_count: number | string }>;
    }).rows ?? [];
    return items.map((r) => ({
      screenedAt: r.bucket instanceof Date ? r.bucket : new Date(r.bucket),
      orgCount: Number(r.org_count),
      matchCount: Number(r.match_count),
    }));
  }

  /**
   * Operator decision to downgrade a potential_match to cleared.
   * Stamps the audit row (cleared_by / cleared_at / cleared_reason) and
   * flips the org's rolling state to cleared_by_operator. Idempotent —
   * calling twice with the same inputs leaves the same state.
   */
  async clearScreen(
    tx: Tx,
    input: OfacScreenClearInput,
  ): Promise<OfacScreen> {
    const [row] = await tx
      .update(ofacScreens)
      .set({
        status: "cleared_by_operator",
        clearedBy: input.clearedBy,
        clearedAt: new Date(),
        clearedReason: input.reason,
      })
      .where(eq(ofacScreens.id, input.screenId))
      .returning();
    if (!row) {
      throw new Error(`ofac_screens ${input.screenId} not found`);
    }
    await tx
      .update(organizations)
      .set({
        ofacStatus: "cleared_by_operator",
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(organizations.id, row.orgId),
          // Only downgrade if the org is still in a "match" state. Guards
          // against a stale clearScreen call flipping a newly-flagged org
          // back to cleared.
          inArray(organizations.ofacStatus, [
            "potential_match",
            "confirmed_match",
          ]),
        ),
      );
    return row;
  }
}
