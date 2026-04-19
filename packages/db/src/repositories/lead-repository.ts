import { and, desc, eq, inArray, lt } from "drizzle-orm";
import { createId } from "@vex/domain";
import type { LeadStatus } from "@vex/domain";
import type { Tx } from "../client.js";
import { leads, type Lead } from "../schema/leads.js";

export interface LeadCreateInput {
  orgId: string;
  contactId: string | null;
  status?: LeadStatus;
  stage?: string | null;
  qualificationSummary?: string | null;
  externalKeys?: Record<string, string>;
}

/** Stateless. Caller must wrap in `withTenant` so RLS scopes the queries. */
export class LeadRepository {
  async findById(tx: Tx, id: string): Promise<Lead | null> {
    const [row] = await tx.select().from(leads).where(eq(leads.id, id)).limit(1);
    return row ?? null;
  }

  async findByOrgId(tx: Tx, orgId: string): Promise<Lead[]> {
    return tx.select().from(leads).where(eq(leads.orgId, orgId));
  }

  /**
   * Look up a lead by a `{system, key}` pair inside externalKeys. Used by
   * the website-chat normalizer to find the lead row created on
   * conversation.started when the follow-up conversation.ended event
   * arrives later.
   */
  async findByExternalKey(
    tx: Tx,
    system: string,
    key: string,
  ): Promise<Lead | null> {
    const rows = await tx.select().from(leads);
    return rows.find((row) => row.externalKeys[system] === key) ?? null;
  }

  async create(
    tx: Tx,
    tenantId: string,
    input: LeadCreateInput,
  ): Promise<Lead> {
    const [row] = await tx
      .insert(leads)
      .values({
        id: createId(),
        tenantId,
        orgId: input.orgId,
        contactId: input.contactId,
        status: input.status ?? "new",
        stage: input.stage ?? null,
        qualificationSummary: input.qualificationSummary ?? null,
        externalKeys: input.externalKeys ?? {},
      })
      .returning();
    if (!row) throw new Error("lead insert returned no row");
    return row;
  }

  async updateQualification(
    tx: Tx,
    id: string,
    summary: string,
  ): Promise<void> {
    await tx
      .update(leads)
      .set({ qualificationSummary: summary, updatedAt: new Date() })
      .where(eq(leads.id, id));
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
