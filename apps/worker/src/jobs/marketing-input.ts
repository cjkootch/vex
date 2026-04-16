import {
  withTenant,
  type CampaignRepository,
  type Db,
  type EventRepository,
} from "@vex/db";
import type {
  MarketingAnalystInput,
  MarketingMetricSnapshot,
} from "@vex/agents";

const REPORT_WINDOW_DAYS = 7;
const HISTORY_WINDOW_DAYS = 30;

const MARKETING_VERBS = [
  "ga4.session",
  "ga4.conversion",
  "ga4.pageview_aggregate",
];

export interface BuildMarketingInputDeps {
  db: Db;
  campaigns: CampaignRepository;
  events: EventRepository;
}

/**
 * Pull the last 30 days of GA4 events out of the canonical `events` table
 * and roll them into the agent input shape:
 *   - `current` is the most recent 7-day window per (metric, subject)
 *   - `history` is the daily series for the prior 23 days (oldest first)
 *   - `campaigns` rolls up sessions/conversions per active campaign
 */
export async function buildMarketingAnalystInput(
  deps: BuildMarketingInputDeps,
  workspaceId: string,
): Promise<MarketingAnalystInput> {
  const since = new Date(
    Date.now() - HISTORY_WINDOW_DAYS * 24 * 60 * 60 * 1000,
  );
  const reportSince = new Date(
    Date.now() - REPORT_WINDOW_DAYS * 24 * 60 * 60 * 1000,
  );

  return withTenant(deps.db, workspaceId, async (tx) => {
    const rows = await deps.events.listByVerbsSince(tx, MARKETING_VERBS, since, 1000);

    const currentMap = new Map<string, MarketingMetricSnapshot>();
    const historyByKey = new Map<string, MarketingMetricSnapshot[]>();
    const campaignAgg = new Map<
      string,
      { sessions: number; conversions: number; channel: string; campaign: string }
    >();

    for (const row of rows) {
      const md = row.metadata as Record<string, unknown>;
      let metric: string | null = null;
      let value = 0;
      let subjectType: MarketingMetricSnapshot["subjectType"] = "workspace";
      let subjectId = workspaceId;

      if (row.verb === "ga4.session") {
        metric = "ga4.sessions";
        value = Number(md["sessions"] ?? 0);
        const source = (md["source"] as string) ?? "(direct)";
        const medium = (md["medium"] as string) ?? "(none)";
        const key = `${source}/${medium}`;
        const agg = campaignAgg.get(key) ?? {
          sessions: 0,
          conversions: 0,
          channel: medium,
          campaign: source,
        };
        agg.sessions += value;
        campaignAgg.set(key, agg);
      } else if (row.verb === "ga4.conversion") {
        metric = "ga4.conversions";
        value = Number(md["conversions"] ?? 0);
        const campaign = (md["campaign"] as string) ?? "(not set)";
        subjectType = "campaign";
        subjectId = campaign;
        const agg = campaignAgg.get(campaign) ?? {
          sessions: 0,
          conversions: 0,
          channel: "unknown",
          campaign,
        };
        agg.conversions += value;
        campaignAgg.set(campaign, agg);
      } else if (row.verb === "ga4.pageview_aggregate") {
        metric = "ga4.pageviews";
        value = Number(md["pageviews"] ?? 0);
      }
      if (!metric) continue;

      const snap: MarketingMetricSnapshot = {
        metric,
        subjectType,
        subjectId,
        value,
        windowEnd: row.occurredAt.toISOString(),
      };

      const key = `${metric}|${subjectType}|${subjectId}`;
      const existingHist = historyByKey.get(key) ?? [];
      existingHist.push(snap);
      historyByKey.set(key, existingHist);

      if (row.occurredAt >= reportSince) {
        const cur = currentMap.get(key);
        if (!cur) currentMap.set(key, snap);
        else cur.value += value;
      }
    }

    const history: MarketingMetricSnapshot[] = [];
    for (const [, samples] of historyByKey) {
      samples.sort((a, b) => a.windowEnd.localeCompare(b.windowEnd));
      const cutoff = reportSince.toISOString();
      for (const s of samples) if (s.windowEnd < cutoff) history.push(s);
    }

    const allCampaigns = await deps.campaigns.listActive(tx, 100);
    const campaigns: MarketingAnalystInput["campaigns"] = [];
    for (const [name, agg] of campaignAgg) {
      const matched = allCampaigns.find(
        (c) => c.source === agg.campaign && c.medium === agg.channel,
      );
      const id = matched?.id ?? name;
      const clickRate = agg.sessions > 0 ? agg.conversions / agg.sessions : 0;
      campaigns.push({
        campaignId: id,
        campaign: matched?.source ?? agg.campaign,
        channel: matched?.channel ?? agg.channel,
        sessions: agg.sessions,
        conversions: agg.conversions,
        clickRate: Math.round(clickRate * 1000) / 1000,
      });
    }
    for (const c of allCampaigns) {
      if (!campaigns.some((row) => row.campaignId === c.id)) {
        campaigns.push({
          campaignId: c.id,
          campaign: c.source ?? c.channel,
          channel: c.channel,
          sessions: 0,
          conversions: 0,
          clickRate: 0,
        });
      }
    }

    return {
      current: [...currentMap.values()],
      history,
      campaigns,
    };
  });
}
