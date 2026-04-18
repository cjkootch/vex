import { and, desc, eq, sql } from "drizzle-orm";
import type { CampaignStatus } from "@vex/domain";
import type { Tx } from "../client.js";
import { campaigns, type Campaign } from "../schema/campaigns.js";
import { touchpoints, type Touchpoint } from "../schema/touchpoints.js";

/**
 * Campaign repository — read-oriented. Writes happen in the Resend
 * webhook ingestion path today; the Marketing tab only needs list +
 * detail + per-campaign rollups.
 *
 * Every method takes a `tx` from {@link withTenant} so RLS filters by
 * `app.tenant_id`. The `listWithRollups` helper derives five counters
 * (sent/delivered/opened/clicked/bounced) from the `touchpoints.channel`
 * text column — Resend events land as `email.sent`, `email.delivered`,
 * etc. (see packages/integrations/src/normalizers/resend.ts). The
 * aggregation runs as a single grouped LEFT JOIN so a campaign with
 * zero touchpoints still comes back with `touchpointCount = 0`.
 */

export interface CampaignRollups {
  touchpointCount: number;
  sent: number;
  delivered: number;
  opened: number;
  clicked: number;
  bounced: number;
}

export type CampaignWithRollups = Campaign & CampaignRollups;

export class CampaignRepository {
  async findById(tx: Tx, id: string): Promise<Campaign | null> {
    const [row] = await tx
      .select()
      .from(campaigns)
      .where(eq(campaigns.id, id))
      .limit(1);
    return row ?? null;
  }

  async list(tx: Tx, limit = 100): Promise<Campaign[]> {
    return tx
      .select()
      .from(campaigns)
      .orderBy(desc(campaigns.updatedAt))
      .limit(limit);
  }

  /**
   * List campaigns with rollup counters derived from touchpoints.
   * Single SQL statement: left join + group by + conditional sums on
   * the `channel` text value.
   */
  async listWithRollups(
    tx: Tx,
    limit = 100,
    status?: CampaignStatus | null,
  ): Promise<CampaignWithRollups[]> {
    const base = tx
      .select({
        id: campaigns.id,
        tenantId: campaigns.tenantId,
        channel: campaigns.channel,
        source: campaigns.source,
        medium: campaigns.medium,
        accountRef: campaigns.accountRef,
        spend: campaigns.spend,
        objective: campaigns.objective,
        externalKeys: campaigns.externalKeys,
        status: campaigns.status,
        createdAt: campaigns.createdAt,
        updatedAt: campaigns.updatedAt,
        touchpointCount:
          sql<number>`count(${touchpoints.id})::int`.as("touchpoint_count"),
        sent: sql<number>`sum(case when ${touchpoints.channel} = 'email.sent' then 1 else 0 end)::int`.as(
          "sent",
        ),
        delivered: sql<number>`sum(case when ${touchpoints.channel} = 'email.delivered' then 1 else 0 end)::int`.as(
          "delivered",
        ),
        opened: sql<number>`sum(case when ${touchpoints.channel} = 'email.opened' then 1 else 0 end)::int`.as(
          "opened",
        ),
        clicked: sql<number>`sum(case when ${touchpoints.channel} = 'email.clicked' then 1 else 0 end)::int`.as(
          "clicked",
        ),
        bounced: sql<number>`sum(case when ${touchpoints.channel} = 'email.bounced' then 1 else 0 end)::int`.as(
          "bounced",
        ),
      })
      .from(campaigns)
      .leftJoin(touchpoints, eq(touchpoints.campaignId, campaigns.id))
      .groupBy(campaigns.id);

    const filtered = status
      ? base.where(eq(campaigns.status, status))
      : base;

    const rows = await filtered.orderBy(desc(campaigns.updatedAt)).limit(limit);
    return rows.map((row) => ({
      id: row.id,
      tenantId: row.tenantId,
      channel: row.channel,
      source: row.source,
      medium: row.medium,
      accountRef: row.accountRef,
      spend: row.spend,
      objective: row.objective,
      externalKeys: row.externalKeys,
      status: row.status,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      touchpointCount: row.touchpointCount ?? 0,
      sent: row.sent ?? 0,
      delivered: row.delivered ?? 0,
      opened: row.opened ?? 0,
      clicked: row.clicked ?? 0,
      bounced: row.bounced ?? 0,
    }));
  }

  /**
   * Rollups for a single campaign — same shape as `listWithRollups`
   * but scoped to one id. Returns null when the campaign isn't
   * visible under the current tenant.
   */
  async findByIdWithRollups(
    tx: Tx,
    id: string,
  ): Promise<CampaignWithRollups | null> {
    const [row] = await tx
      .select({
        id: campaigns.id,
        tenantId: campaigns.tenantId,
        channel: campaigns.channel,
        source: campaigns.source,
        medium: campaigns.medium,
        accountRef: campaigns.accountRef,
        spend: campaigns.spend,
        objective: campaigns.objective,
        externalKeys: campaigns.externalKeys,
        status: campaigns.status,
        createdAt: campaigns.createdAt,
        updatedAt: campaigns.updatedAt,
        touchpointCount:
          sql<number>`count(${touchpoints.id})::int`.as("touchpoint_count"),
        sent: sql<number>`sum(case when ${touchpoints.channel} = 'email.sent' then 1 else 0 end)::int`.as(
          "sent",
        ),
        delivered: sql<number>`sum(case when ${touchpoints.channel} = 'email.delivered' then 1 else 0 end)::int`.as(
          "delivered",
        ),
        opened: sql<number>`sum(case when ${touchpoints.channel} = 'email.opened' then 1 else 0 end)::int`.as(
          "opened",
        ),
        clicked: sql<number>`sum(case when ${touchpoints.channel} = 'email.clicked' then 1 else 0 end)::int`.as(
          "clicked",
        ),
        bounced: sql<number>`sum(case when ${touchpoints.channel} = 'email.bounced' then 1 else 0 end)::int`.as(
          "bounced",
        ),
      })
      .from(campaigns)
      .leftJoin(touchpoints, eq(touchpoints.campaignId, campaigns.id))
      .where(eq(campaigns.id, id))
      .groupBy(campaigns.id)
      .limit(1);
    if (!row) return null;
    return {
      id: row.id,
      tenantId: row.tenantId,
      channel: row.channel,
      source: row.source,
      medium: row.medium,
      accountRef: row.accountRef,
      spend: row.spend,
      objective: row.objective,
      externalKeys: row.externalKeys,
      status: row.status,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      touchpointCount: row.touchpointCount ?? 0,
      sent: row.sent ?? 0,
      delivered: row.delivered ?? 0,
      opened: row.opened ?? 0,
      clicked: row.clicked ?? 0,
      bounced: row.bounced ?? 0,
    };
  }

  /**
   * Last N touchpoints for a campaign — used on the detail page to
   * render the activity feed. Ordered newest-first.
   */
  async listTouchpointsForCampaign(
    tx: Tx,
    campaignId: string,
    limit = 50,
  ): Promise<Touchpoint[]> {
    return tx
      .select()
      .from(touchpoints)
      .where(and(eq(touchpoints.campaignId, campaignId)))
      .orderBy(desc(touchpoints.occurredAt))
      .limit(limit);
  }
}
