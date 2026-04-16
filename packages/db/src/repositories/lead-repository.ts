import { eq } from "drizzle-orm";
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
}
