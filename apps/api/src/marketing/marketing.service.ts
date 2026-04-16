import { Inject, Injectable, NotFoundException } from "@nestjs/common";
import {
  withTenant,
  type CampaignRepository,
  type Db,
  type EventRepository,
  type SummaryRepository,
  type TouchpointRepository,
} from "@vex/db";
import {
  MARKETING_CAMPAIGN_REPO,
  MARKETING_DB_CLIENT,
  MARKETING_EVENT_REPO,
  MARKETING_SUMMARY_REPO,
  MARKETING_TOUCHPOINT_REPO,
} from "./tokens.js";

const ANOMALY_LOOKBACK_DAYS = 7;
const CAMPAIGN_WINDOW_DAYS = 7;

export interface MarketingOverview {
  summaryId: string | null;
  payload: unknown;
  generatedAt: string | null;
}

export interface MarketingCampaignDetail {
  campaignId: string;
  campaign: {
    id: string;
    channel: string;
    source: string | null;
    medium: string | null;
    accountRef: string | null;
    objective: string | null;
    spend: number | null;
    status: string;
  };
  ga4: { sessions: number; conversions: number };
  emailFunnel: { sent: number; opened: number; clicked: number };
  latestSummary: { id: string; content: string; createdAt: string } | null;
}

export interface MarketingAnomaly {
  id: string;
  metric: string;
  subjectType: string;
  subjectId: string;
  occurredAt: string;
  zScore: number;
  direction: string;
  latest: number;
  mean: number;
}

@Injectable()
export class MarketingService {
  constructor(
    @Inject(MARKETING_DB_CLIENT) private readonly db: Db,
    @Inject(MARKETING_SUMMARY_REPO) private readonly summaries: SummaryRepository,
    @Inject(MARKETING_CAMPAIGN_REPO) private readonly campaigns: CampaignRepository,
    @Inject(MARKETING_EVENT_REPO) private readonly events: EventRepository,
    @Inject(MARKETING_TOUCHPOINT_REPO) private readonly touchpoints: TouchpointRepository,
  ) {}

  async overview(tenantId: string, workspaceId: string): Promise<MarketingOverview> {
    return withTenant(this.db, tenantId, async (tx) => {
      const summary = await this.summaries.getLatest(
        tx,
        "workspace",
        workspaceId,
        "marketing_overview",
      );
      if (!summary) {
        return { summaryId: null, payload: null, generatedAt: null };
      }
      let payload: unknown = null;
      try {
        payload = JSON.parse(summary.content);
      } catch {
        payload = { answer: summary.content };
      }
      return {
        summaryId: summary.id,
        payload,
        generatedAt: summary.createdAt.toISOString(),
      };
    });
  }

  async campaign(tenantId: string, campaignId: string): Promise<MarketingCampaignDetail> {
    return withTenant(this.db, tenantId, async (tx) => {
      const campaign = await this.campaigns.findById(tx, campaignId);
      if (!campaign) throw new NotFoundException(`campaign ${campaignId} not found`);

      const since = new Date(Date.now() - CAMPAIGN_WINDOW_DAYS * 24 * 60 * 60 * 1000);

      const ga4Rows = await this.events.listForObjectSince(tx, campaignId, since);
      let sessions = 0;
      let conversions = 0;
      for (const r of ga4Rows) {
        const md = r.metadata as Record<string, unknown>;
        if (r.verb === "ga4.session") sessions += Number(md["sessions"] ?? 0);
        if (r.verb === "ga4.conversion") conversions += Number(md["conversions"] ?? 0);
      }

      const tps = await this.touchpoints.listForCampaignSince(
        tx,
        campaignId,
        since,
        "email",
      );
      let sent = 0;
      let opened = 0;
      let clicked = 0;
      for (const t of tps) {
        const md = t.metadata as Record<string, unknown>;
        const verb = (md["verb"] as string) ?? "";
        if (verb === "email.sent" || verb.endsWith("sent")) sent++;
        if (verb === "email.opened" || verb.endsWith("opened")) opened++;
        if (verb === "email.clicked" || verb.endsWith("clicked")) clicked++;
      }

      const latestSummary = await this.summaries.getLatest(
        tx,
        "campaign",
        campaignId,
        "campaign_marketing",
      );

      return {
        campaignId,
        campaign: {
          id: campaign.id,
          channel: campaign.channel,
          source: campaign.source,
          medium: campaign.medium,
          accountRef: campaign.accountRef,
          objective: campaign.objective,
          spend: campaign.spend,
          status: campaign.status,
        },
        ga4: { sessions, conversions },
        emailFunnel: { sent, opened, clicked },
        latestSummary: latestSummary
          ? {
              id: latestSummary.id,
              content: latestSummary.content,
              createdAt: latestSummary.createdAt.toISOString(),
            }
          : null,
      };
    });
  }

  async anomalies(tenantId: string): Promise<MarketingAnomaly[]> {
    const since = new Date(Date.now() - ANOMALY_LOOKBACK_DAYS * 24 * 60 * 60 * 1000);
    return withTenant(this.db, tenantId, async (tx) => {
      const rows = await this.events.listByVerbSince(
        tx,
        "marketing.anomaly",
        since,
        100,
      );
      return rows.map((r) => {
        const md = r.metadata as Record<string, unknown>;
        return {
          id: r.id,
          metric: r.objectId ?? "",
          subjectType: r.subjectType,
          subjectId: r.subjectId,
          occurredAt: r.occurredAt.toISOString(),
          zScore: Number(md["z_score"] ?? 0),
          direction: String(md["direction"] ?? "flat"),
          latest: Number(md["latest"] ?? 0),
          mean: Number(md["mean"] ?? 0),
        } satisfies MarketingAnomaly;
      });
    });
  }
}
