import {
  BadRequestException,
  Controller,
  Get,
  Inject,
  NotFoundException,
  Param,
  Query,
  UseGuards,
} from "@nestjs/common";
import type { CampaignStatus } from "@vex/domain";
import type {
  CampaignRepository,
  CampaignWithRollups,
  TouchpointRepository,
} from "@vex/db";
import { JwtAuthGuard, TenantContext } from "../auth/index.js";
import { withTenant, type Db } from "@vex/db";

/**
 * GET /marketing/campaigns
 *   List campaigns for the current tenant with rollup counters
 *   (touchpointCount + sent/delivered/opened/clicked/bounced derived
 *   from touchpoints.channel). Optional `?status=` filter, `?limit=N`
 *   capped at 500.
 *
 * GET /marketing/campaigns/:id
 *   Single-campaign detail with the same rollups + the last 50
 *   touchpoints (newest-first).
 *
 * Both endpoints run inside `withTenant` so RLS isolates the query.
 */

export const MARKETING_DB_CLIENT = Symbol("MARKETING_DB_CLIENT");
export const MARKETING_CAMPAIGNS_REPO = Symbol("MARKETING_CAMPAIGNS_REPO");
export const MARKETING_TOUCHPOINTS_REPO = Symbol("MARKETING_TOUCHPOINTS_REPO");

const CAMPAIGN_STATUSES = new Set<CampaignStatus>([
  "active",
  "paused",
  "completed",
  "archived",
]);

export interface CampaignListRow {
  id: string;
  channel: string;
  source: string | null;
  medium: string | null;
  accountRef: string | null;
  spend: number | null;
  objective: string | null;
  status: string;
  touchpointCount: number;
  sent: number;
  delivered: number;
  opened: number;
  clicked: number;
  bounced: number;
  createdAt: string;
  updatedAt: string;
}

export interface CampaignTouchpointRow {
  id: string;
  channel: string;
  actor: string | null;
  occurredAt: string;
  contactId: string | null;
  orgId: string | null;
  leadId: string | null;
  campaignId: string | null;
  metadata: Record<string, unknown>;
}

export interface CampaignDetail extends CampaignListRow {
  touchpoints: CampaignTouchpointRow[];
}

@Controller("marketing")
@UseGuards(JwtAuthGuard)
export class MarketingController {
  constructor(
    @Inject(TenantContext) private readonly tenant: TenantContext,
    @Inject(MARKETING_DB_CLIENT) private readonly db: Db,
    @Inject(MARKETING_CAMPAIGNS_REPO)
    private readonly campaigns: CampaignRepository,
    @Inject(MARKETING_TOUCHPOINTS_REPO)
    private readonly touchpoints: TouchpointRepository,
  ) {}

  @Get("campaigns")
  async list(
    @Query("status") statusRaw?: string,
    @Query("limit") limitRaw?: string,
  ): Promise<{ campaigns: CampaignListRow[] }> {
    const status = parseStatus(statusRaw);
    const limit = clampLimit(limitRaw, 100, 500);

    const rows = await withTenant(this.db, this.tenant.tenantId, async (tx) => {
      return this.campaigns.listWithRollups(tx, limit, status);
    });

    return { campaigns: rows.map(toListRow) };
  }

  @Get("campaigns/:id")
  async detail(
    @Param("id") id: string,
  ): Promise<{ campaign: CampaignDetail }> {
    const tenantId = this.tenant.tenantId;

    const detail = await withTenant(this.db, tenantId, async (tx) => {
      const campaign = await this.campaigns.findByIdWithRollups(tx, id);
      if (!campaign) return null;
      const tps = await this.campaigns.listTouchpointsForCampaign(tx, id, 50);
      return {
        campaign: toListRow(campaign),
        touchpoints: tps.map(
          (t): CampaignTouchpointRow => ({
            id: t.id,
            channel: t.channel,
            actor: t.actor,
            occurredAt: t.occurredAt.toISOString(),
            contactId: t.contactId,
            orgId: t.orgId,
            leadId: t.leadId,
            campaignId: t.campaignId,
            metadata: t.metadata,
          }),
        ),
      };
    });

    if (!detail) throw new NotFoundException(`campaign ${id} not found`);
    return {
      campaign: { ...detail.campaign, touchpoints: detail.touchpoints },
    };
  }
}

function toListRow(row: CampaignWithRollups): CampaignListRow {
  return {
    id: row.id,
    channel: row.channel,
    source: row.source,
    medium: row.medium,
    accountRef: row.accountRef,
    spend: row.spend,
    objective: row.objective,
    status: row.status,
    touchpointCount: row.touchpointCount,
    sent: row.sent,
    delivered: row.delivered,
    opened: row.opened,
    clicked: row.clicked,
    bounced: row.bounced,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function parseStatus(raw: string | undefined): CampaignStatus | null {
  if (!raw) return null;
  if (!CAMPAIGN_STATUSES.has(raw as CampaignStatus)) {
    throw new BadRequestException(
      `status '${raw}' not allowed; expected one of active|paused|completed|archived`,
    );
  }
  return raw as CampaignStatus;
}

function clampLimit(raw: string | undefined, fallback: number, max: number): number {
  const parsed = raw ? Number.parseInt(raw, 10) : fallback;
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.min(parsed, max);
}
