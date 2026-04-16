import {
  withTenant,
  type CampaignRepository,
  type Db,
  type EventRepository,
  type TouchpointRepository,
  type WorkspaceRepository,
} from "@vex/db";
import type { GA4Adapter, GA4Report } from "@vex/integrations";
import { createLogger, withSpan } from "@vex/telemetry";

const log = createLogger("worker.ga4-poll");

/**
 * Date range (last 7 days) for the recurring report. GA4 dates are YYYY-MM-DD
 * in the property's timezone, but `7daysAgo`/`today` is the documented way
 * to express rolling windows without needing to compute timezones ourselves.
 */
const REPORT_RANGE = { startDate: "7daysAgo", endDate: "today" };

export interface Ga4PollDeps {
  db: Db;
  workspaces: WorkspaceRepository;
  campaigns: CampaignRepository;
  touchpoints: TouchpointRepository;
  events: EventRepository;
  ga4Factory: (serviceAccount: string) => GA4Adapter;
}

export interface Ga4PollResult {
  skipped: boolean;
  skippedReason?: string;
  sessions: number;
  conversions: number;
  pageviews: number;
  activeUsersNow: number;
  touchpointsInserted: number;
  eventsInserted: number;
}

/**
 * Fetch GA4 data for a workspace and normalize it into canonical events
 * and campaign touchpoints. Idempotent: each canonical event has a stable
 * idempotency key derived from `(verb, propertyId, source, medium, date)`.
 *
 * Skips cleanly when:
 *   - the workspace isn't found
 *   - settings.marketing.ga4_property_id is unset
 *   - GOOGLE_SERVICE_ACCOUNT_JSON is unset (caller passes it in)
 */
export async function runGa4Poll(
  deps: Ga4PollDeps,
  input: { workspaceId: string; serviceAccountJson: string | null },
): Promise<Ga4PollResult> {
  return withSpan(
    "worker.ga4.poll",
    { workspace_id: input.workspaceId },
    async () => {
      const workspace = await deps.workspaces.findById(deps.db, input.workspaceId);
      if (!workspace) {
        return empty("workspace_not_found");
      }
      const propertyId = workspace.settings.marketing?.ga4_property_id;
      if (!propertyId) {
        return empty("ga4_property_id_not_configured");
      }
      if (!input.serviceAccountJson) {
        log.warn("ga4-poll: GOOGLE_SERVICE_ACCOUNT_JSON unset; skipping");
        return empty("service_account_unset");
      }

      const ga4 = deps.ga4Factory(input.serviceAccountJson);
      const [sessionsReport, conversionsReport, pageviewsReport, realtime] =
        await Promise.all([
          ga4.runReport(
            propertyId,
            ["sessionSource", "sessionMedium", "date"],
            ["sessions"],
            REPORT_RANGE,
          ),
          ga4.runReport(
            propertyId,
            ["sessionCampaignName", "date"],
            ["conversions"],
            REPORT_RANGE,
          ),
          ga4.runReport(propertyId, ["date"], ["screenPageViews"], REPORT_RANGE),
          ga4.runRealtimeReport(propertyId, ["country"], ["activeUsers"]),
        ]);

      const sessionsRows = parseRows(sessionsReport, {
        dims: ["sessionSource", "sessionMedium", "date"],
        metrics: ["sessions"],
      });
      const conversionsRows = parseRows(conversionsReport, {
        dims: ["sessionCampaignName", "date"],
        metrics: ["conversions"],
      });
      const pageviewsRows = parseRows(pageviewsReport, {
        dims: ["date"],
        metrics: ["screenPageViews"],
      });
      const activeUsersNow = sumMetric(realtime, "activeUsers");

      const totals = {
        sessions: sumMetric(sessionsReport, "sessions"),
        conversions: sumMetric(conversionsReport, "conversions"),
        pageviews: sumMetric(pageviewsReport, "screenPageViews"),
      };

      let touchpointsInserted = 0;
      let eventsInserted = 0;

      await withTenant(deps.db, input.workspaceId, async (tx) => {
        for (const row of sessionsRows) {
          const source = row.dims["sessionSource"] ?? "(direct)";
          const medium = row.dims["sessionMedium"] ?? "(none)";
          const date = row.dims["date"] ?? "";
          const value = Number(row.metrics["sessions"] ?? 0);
          const occurredAt = parseGa4Date(date);
          const idemp = `ga4.session:${propertyId}:${source}:${medium}:${date}`;
          const evt = await deps.events.insertIfNotExists(tx, input.workspaceId, {
            verb: "ga4.session",
            subjectType: "workspace",
            subjectId: input.workspaceId,
            actorType: "system",
            actorId: "ga4_poll",
            objectType: "campaign",
            objectId: `${source}:${medium}`,
            occurredAt,
            idempotencyKey: idemp,
            metadata: {
              property_id: propertyId,
              source,
              medium,
              sessions: value,
              date,
            },
          });
          if (evt.isNew) eventsInserted++;

          const campaign = await deps.campaigns.findBySourceMedium(tx, source, medium);
          if (campaign) {
            await deps.touchpoints.insert(tx, input.workspaceId, {
              channel: `ga4:${source}/${medium}`,
              occurredAt,
              campaignId: campaign.id,
              metadata: {
                property_id: propertyId,
                sessions: value,
                source,
                medium,
                date,
              },
            });
            touchpointsInserted++;
          }
        }

        for (const row of conversionsRows) {
          const campaign = row.dims["sessionCampaignName"] ?? "(not set)";
          const date = row.dims["date"] ?? "";
          const value = Number(row.metrics["conversions"] ?? 0);
          const occurredAt = parseGa4Date(date);
          const idemp = `ga4.conversion:${propertyId}:${campaign}:${date}`;
          const evt = await deps.events.insertIfNotExists(tx, input.workspaceId, {
            verb: "ga4.conversion",
            subjectType: "workspace",
            subjectId: input.workspaceId,
            actorType: "system",
            actorId: "ga4_poll",
            objectType: "campaign",
            objectId: campaign,
            occurredAt,
            idempotencyKey: idemp,
            metadata: {
              property_id: propertyId,
              campaign,
              conversions: value,
              date,
            },
          });
          if (evt.isNew) eventsInserted++;
        }

        for (const row of pageviewsRows) {
          const date = row.dims["date"] ?? "";
          const value = Number(row.metrics["screenPageViews"] ?? 0);
          const occurredAt = parseGa4Date(date);
          const idemp = `ga4.pageview_aggregate:${propertyId}:${date}`;
          const evt = await deps.events.insertIfNotExists(tx, input.workspaceId, {
            verb: "ga4.pageview_aggregate",
            subjectType: "workspace",
            subjectId: input.workspaceId,
            actorType: "system",
            actorId: "ga4_poll",
            objectType: "workspace",
            objectId: input.workspaceId,
            occurredAt,
            idempotencyKey: idemp,
            metadata: { property_id: propertyId, pageviews: value, date },
          });
          if (evt.isNew) eventsInserted++;
        }
      });

      log.info("ga4-poll complete", {
        workspace_id: input.workspaceId,
        sessions: totals.sessions,
        conversions: totals.conversions,
        pageviews: totals.pageviews,
        active_users_now: activeUsersNow,
        touchpoints_inserted: touchpointsInserted,
        events_inserted: eventsInserted,
      });

      return {
        skipped: false,
        sessions: totals.sessions,
        conversions: totals.conversions,
        pageviews: totals.pageviews,
        activeUsersNow,
        touchpointsInserted,
        eventsInserted,
      };
    },
  );
}

function empty(reason: string): Ga4PollResult {
  return {
    skipped: true,
    skippedReason: reason,
    sessions: 0,
    conversions: 0,
    pageviews: 0,
    activeUsersNow: 0,
    touchpointsInserted: 0,
    eventsInserted: 0,
  };
}

interface ParsedRow {
  dims: Record<string, string>;
  metrics: Record<string, string>;
}

export function parseRows(
  report: GA4Report,
  shape: { dims: string[]; metrics: string[] },
): ParsedRow[] {
  const rows = report.rows ?? [];
  return rows.map((row) => {
    const dims: Record<string, string> = {};
    shape.dims.forEach((name, i) => {
      dims[name] = row.dimensionValues[i]?.value ?? "";
    });
    const metrics: Record<string, string> = {};
    shape.metrics.forEach((name, i) => {
      metrics[name] = row.metricValues[i]?.value ?? "0";
    });
    return { dims, metrics };
  });
}

/**
 * GA4 returns `date` as `YYYYMMDD` (no separators). Parse to a Date at
 * midnight UTC — good enough for aggregation; the window is per-day.
 */
export function parseGa4Date(raw: string): Date {
  if (!/^\d{8}$/.test(raw)) return new Date();
  const y = Number(raw.slice(0, 4));
  const m = Number(raw.slice(4, 6)) - 1;
  const d = Number(raw.slice(6, 8));
  return new Date(Date.UTC(y, m, d));
}

function sumMetric(
  report: { rows?: { metricValues: { value: string }[] }[]; metricHeaders: { name: string }[] },
  metricName: string,
): number {
  const idx = report.metricHeaders.findIndex((h) => h.name === metricName);
  if (idx < 0) return 0;
  let total = 0;
  for (const row of report.rows ?? []) {
    const raw = row.metricValues[idx]?.value ?? "0";
    total += Number(raw);
  }
  return total;
}
