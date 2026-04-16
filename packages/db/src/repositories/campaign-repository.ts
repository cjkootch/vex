import { and, eq, sql } from "drizzle-orm";
import { createId } from "@vex/domain";
import type { Tx } from "../client.js";
import { campaigns, type Campaign, type NewCampaign } from "../schema/campaigns.js";

export interface CampaignUpsertData {
  channel: string;
  source?: string | null;
  medium?: string | null;
  accountRef?: string | null;
  spend?: number | null;
  objective?: string | null;
  externalKeys?: Record<string, string>;
}

/** Stateless. Caller must wrap in `withTenant` so RLS scopes the queries. */
export class CampaignRepository {
  async findById(tx: Tx, id: string): Promise<Campaign | null> {
    const [row] = await tx
      .select()
      .from(campaigns)
      .where(eq(campaigns.id, id))
      .limit(1);
    return row ?? null;
  }

  async listActive(tx: Tx, limit = 100): Promise<Campaign[]> {
    return tx
      .select()
      .from(campaigns)
      .where(eq(campaigns.status, "active"))
      .limit(limit);
  }

  /**
   * Find a campaign by source+medium pair. Used by the GA4 poller to
   * attribute incoming sessions to an existing campaign record without
   * an explicit external key.
   */
  async findBySourceMedium(
    tx: Tx,
    source: string,
    medium: string,
  ): Promise<Campaign | null> {
    const [row] = await tx
      .select()
      .from(campaigns)
      .where(and(eq(campaigns.source, source), eq(campaigns.medium, medium)))
      .limit(1);
    return row ?? null;
  }

  /**
   * Find by an external key match (e.g. `ga4: <propertyId>:<campaignId>`).
   * Drizzle's jsonb operators don't expose `?` in this version, so we
   * fall through to raw SQL with parameterised values.
   */
  async findByExternalKey(
    tx: Tx,
    system: string,
    key: string,
  ): Promise<Campaign | null> {
    const result = await tx.execute(
      sql`select * from campaigns where external_keys ->> ${system} = ${key} limit 1`,
    );
    const rows = ((result as unknown as { rows?: unknown[] }).rows ??
      (result as unknown as unknown[])) as Campaign[];
    return rows[0] ?? null;
  }

  async create(tx: Tx, tenantId: string, data: CampaignUpsertData): Promise<Campaign> {
    const insert: NewCampaign = {
      id: createId(),
      tenantId,
      channel: data.channel,
      source: data.source ?? null,
      medium: data.medium ?? null,
      accountRef: data.accountRef ?? null,
      spend: data.spend ?? null,
      objective: data.objective ?? null,
      externalKeys: data.externalKeys ?? {},
      status: "active",
    };
    const [row] = await tx.insert(campaigns).values(insert).returning();
    if (!row) throw new Error("campaign insert returned no row");
    return row;
  }
}
