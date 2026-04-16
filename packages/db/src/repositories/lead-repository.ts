import { and, eq } from "drizzle-orm";
import type { Db } from "../client.js";
import { leads, type Lead } from "../schema/leads.js";
import type { LeadStatus } from "@vex/domain";

export class LeadRepository {
  constructor(private readonly db: Db) {}

  async findById(tenantId: string, id: string): Promise<Lead | null> {
    const [row] = await this.db
      .select()
      .from(leads)
      .where(and(eq(leads.tenantId, tenantId), eq(leads.id, id)))
      .limit(1);
    return row ?? null;
  }

  async findByOrgId(tenantId: string, orgId: string): Promise<Lead[]> {
    return this.db
      .select()
      .from(leads)
      .where(and(eq(leads.tenantId, tenantId), eq(leads.orgId, orgId)));
  }

  async updateStatus(tenantId: string, id: string, status: LeadStatus): Promise<void> {
    await this.db
      .update(leads)
      .set({ status, updatedAt: new Date() })
      .where(and(eq(leads.tenantId, tenantId), eq(leads.id, id)));
  }
}
