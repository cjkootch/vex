import { and, desc, eq, gte, lt } from "drizzle-orm";
import { createId } from "@vex/domain";
import type { Tx } from "../client.js";
import { touchpoints, type Touchpoint } from "../schema/touchpoints.js";

export interface TouchpointInsert {
  channel: string;
  actor?: string | null;
  occurredAt: Date;
  campaignId?: string | null;
  leadId?: string | null;
  contactId?: string | null;
  orgId?: string | null;
  metadata?: Record<string, unknown>;
}

export class TouchpointRepository {
  async insert(tx: Tx, tenantId: string, data: TouchpointInsert): Promise<Touchpoint> {
    const [row] = await tx
      .insert(touchpoints)
      .values({
        id: createId(),
        tenantId,
        channel: data.channel,
        actor: data.actor ?? null,
        occurredAt: data.occurredAt,
        campaignId: data.campaignId ?? null,
        leadId: data.leadId ?? null,
        contactId: data.contactId ?? null,
        orgId: data.orgId ?? null,
        metadata: data.metadata ?? {},
      })
      .returning();
    if (!row) throw new Error("touchpoint insert returned no row");
    return row;
  }

  /** Touchpoints with `occurred_at >= since`. Used by DailyBriefAgent. */
  async listSince(tx: Tx, since: Date, limit = 200): Promise<Touchpoint[]> {
    return tx
      .select()
      .from(touchpoints)
      .where(gte(touchpoints.occurredAt, since))
      .orderBy(desc(touchpoints.occurredAt))
      .limit(limit);
  }

  /**
   * Touchpoints with \`start <= occurred_at < end\`. Bounded on both
   * sides so the AnalystAgent's week-over-week windows don't steal
   * rows from each other when the tenant exceeds the per-query limit.
   */
  async listBetween(
    tx: Tx,
    start: Date,
    end: Date,
    limit = 2000,
  ): Promise<Touchpoint[]> {
    return tx
      .select()
      .from(touchpoints)
      .where(
        and(
          gte(touchpoints.occurredAt, start),
          lt(touchpoints.occurredAt, end),
        ),
      )
      .orderBy(desc(touchpoints.occurredAt))
      .limit(limit);
  }

  /** Touchpoints for a specific org since `since`. Used by ResearchAgent. */
  async listForOrgSince(
    tx: Tx,
    orgId: string,
    since: Date,
    limit = 50,
  ): Promise<Touchpoint[]> {
    return tx
      .select()
      .from(touchpoints)
      .where(and(eq(touchpoints.orgId, orgId), gte(touchpoints.occurredAt, since)))
      .orderBy(desc(touchpoints.occurredAt))
      .limit(limit);
  }
}
