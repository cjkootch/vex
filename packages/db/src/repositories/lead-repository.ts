import { and, desc, eq, inArray, lt } from "drizzle-orm";
import type { LeadStatus } from "@vex/domain";
import type { Tx } from "../client.js";
import { leads, type Lead } from "../schema/leads.js";

/** Stateless. Caller must wrap in `withTenant` so RLS scopes the queries. */
export class LeadRepository {
  async findById(tx: Tx, id: string): Promise<Lead | null> {
    const [row] = await tx.select().from(leads).where(eq(leads.id, id)).limit(1);
    return row ?? null;
  }

  async findByOrgId(tx: Tx, orgId: string): Promise<Lead[]> {
    return tx.select().from(leads).where(eq(leads.orgId, orgId));
  }

  async updateStatus(tx: Tx, id: string, status: LeadStatus): Promise<void> {
    await tx
      .update(leads)
      .set({ status, updatedAt: new Date() })
      .where(eq(leads.id, id));
  }

  /**
   * Leads in active stages (anything except won/lost/disqualified) that
   * haven't moved in `cutoff` time. Powers the follow-up agent's stale-
   * pipeline scan.
   */
  async listStale(tx: Tx, cutoff: Date, limit = 50): Promise<Lead[]> {
    const activeStatuses: LeadStatus[] = ["new", "qualified"];
    return tx
      .select()
      .from(leads)
      .where(and(inArray(leads.status, activeStatuses), lt(leads.updatedAt, cutoff)))
      .orderBy(desc(leads.updatedAt))
      .limit(limit);
  }
}
