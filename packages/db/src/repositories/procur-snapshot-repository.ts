import { and, eq, lt } from "drizzle-orm";
import { createId } from "@vex/domain";
import type { Tx } from "../client.js";
import {
  procurIntelligenceSnapshots,
  type ProcurIntelligenceSnapshot,
} from "../schema/procur-intelligence-snapshots.js";

export interface ProcurSnapshotUpsertInput {
  orgId: string;
  procurTool: string;
  queryHash: string;
  payload: Record<string, unknown>;
  /** When this snapshot should be considered stale and re-fetched. */
  expiresAt: Date;
}

/**
 * Repository for `procur_intelligence_snapshots`. Stateless; every
 * call takes a `tx` so RLS scopes the read/write to the current tenant.
 *
 * Key behaviours:
 *   - `upsert` — insert-or-update on the (tenant_id, org_id,
 *     procur_tool, query_hash) unique key. ProcurEnrichmentAgent calls
 *     this every time it re-fetches; the existing row's payload +
 *     timestamps get replaced rather than orphaned.
 *   - `findFresh` — returns the most-recent non-expired snapshot for
 *     a given (org, tool) so agents skip the round-trip to procur
 *     when there's a usable cached payload.
 *   - `purgeExpired` — admin/cron utility to drop snapshots past
 *     their expiry. Cheap because the `expires_at` index covers it.
 */
export class ProcurSnapshotRepository {
  /**
   * Upsert a snapshot. Returns the resolved row. ON CONFLICT updates
   * payload + fetched_at + expires_at so subsequent finds see fresh
   * data without a duplicate row.
   */
  async upsert(
    tx: Tx,
    tenantId: string,
    input: ProcurSnapshotUpsertInput,
  ): Promise<ProcurIntelligenceSnapshot> {
    const id = createId();
    const fetchedAt = new Date();
    const [row] = await tx
      .insert(procurIntelligenceSnapshots)
      .values({
        id,
        tenantId,
        orgId: input.orgId,
        procurTool: input.procurTool,
        queryHash: input.queryHash,
        payload: input.payload,
        fetchedAt,
        expiresAt: input.expiresAt,
      })
      .onConflictDoUpdate({
        target: [
          procurIntelligenceSnapshots.tenantId,
          procurIntelligenceSnapshots.orgId,
          procurIntelligenceSnapshots.procurTool,
          procurIntelligenceSnapshots.queryHash,
        ],
        set: {
          payload: input.payload,
          fetchedAt,
          expiresAt: input.expiresAt,
        },
      })
      .returning();
    if (!row) throw new Error("procur snapshot upsert returned no row");
    return row;
  }

  /**
   * Find a non-expired snapshot for the given (org, tool, query_hash).
   * Returns null when no snapshot exists OR when the only snapshot is
   * stale. Callers that want to read stale data on a procur outage
   * should use `findAny` instead.
   */
  async findFresh(
    tx: Tx,
    orgId: string,
    procurTool: string,
    queryHash: string,
    now: Date = new Date(),
  ): Promise<ProcurIntelligenceSnapshot | null> {
    const rows = await tx
      .select()
      .from(procurIntelligenceSnapshots)
      .where(
        and(
          eq(procurIntelligenceSnapshots.orgId, orgId),
          eq(procurIntelligenceSnapshots.procurTool, procurTool),
          eq(procurIntelligenceSnapshots.queryHash, queryHash),
        ),
      )
      .limit(1);
    const row = rows[0];
    if (!row) return null;
    return row.expiresAt > now ? row : null;
  }

  /**
   * Find any snapshot — fresh or stale — for the given (org, tool,
   * query_hash). Used as a fallback on procur outage so the UI can
   * still render the last-known intelligence with a "stale" badge.
   */
  async findAny(
    tx: Tx,
    orgId: string,
    procurTool: string,
    queryHash: string,
  ): Promise<ProcurIntelligenceSnapshot | null> {
    const rows = await tx
      .select()
      .from(procurIntelligenceSnapshots)
      .where(
        and(
          eq(procurIntelligenceSnapshots.orgId, orgId),
          eq(procurIntelligenceSnapshots.procurTool, procurTool),
          eq(procurIntelligenceSnapshots.queryHash, queryHash),
        ),
      )
      .limit(1);
    return rows[0] ?? null;
  }

  /**
   * List every snapshot recorded for an organization, regardless of
   * tool. Powers the org-detail "Procur Intelligence" tab so the UI
   * can render the most-recent of each tool side-by-side.
   */
  async listForOrg(
    tx: Tx,
    orgId: string,
  ): Promise<ProcurIntelligenceSnapshot[]> {
    return tx
      .select()
      .from(procurIntelligenceSnapshots)
      .where(eq(procurIntelligenceSnapshots.orgId, orgId));
  }

  /**
   * Drop every snapshot whose `expires_at` is before `cutoff`. Returns
   * the number of rows deleted. Run nightly to keep the table from
   * growing unbounded with stale data the cache layer never re-reads.
   */
  async purgeExpired(tx: Tx, cutoff: Date = new Date()): Promise<number> {
    const result = await tx
      .delete(procurIntelligenceSnapshots)
      .where(lt(procurIntelligenceSnapshots.expiresAt, cutoff))
      .returning({ id: procurIntelligenceSnapshots.id });
    return result.length;
  }
}
