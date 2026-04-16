import { describe, expect, it, vi } from "vitest";
import { runGa4Poll, parseGa4Date, parseRows } from "./ga4-poll.js";

const FAKE_REPORT = (
  dims: string[],
  metrics: string[],
  rows: { dims: string[]; metrics: string[] }[],
) => ({
  dimensionHeaders: dims.map((name) => ({ name })),
  metricHeaders: metrics.map((name) => ({ name, type: "TYPE_INTEGER" })),
  rows: rows.map((r) => ({
    dimensionValues: r.dims.map((value) => ({ value })),
    metricValues: r.metrics.map((value) => ({ value })),
  })),
});

const SESSIONS = FAKE_REPORT(
  ["sessionSource", "sessionMedium", "date"],
  ["sessions"],
  [
    { dims: ["google", "cpc", "20260801"], metrics: ["120"] },
    { dims: ["(direct)", "(none)", "20260801"], metrics: ["80"] },
  ],
);
const CONVERSIONS = FAKE_REPORT(
  ["sessionCampaignName", "date"],
  ["conversions"],
  [{ dims: ["spring_promo", "20260801"], metrics: ["7"] }],
);
const PAGEVIEWS = FAKE_REPORT(
  ["date"],
  ["screenPageViews"],
  [{ dims: ["20260801"], metrics: ["350"] }],
);
const REALTIME = FAKE_REPORT(
  ["country"],
  ["activeUsers"],
  [{ dims: ["US"], metrics: ["12"] }],
);

describe("parseGa4Date", () => {
  it("parses YYYYMMDD into a UTC midnight Date", () => {
    const d = parseGa4Date("20260801");
    expect(d.toISOString()).toBe("2026-08-01T00:00:00.000Z");
  });
  it("falls back to now() on malformed input", () => {
    const d = parseGa4Date("garbage");
    expect(d.getTime()).toBeGreaterThan(Date.now() - 5_000);
  });
});

describe("parseRows", () => {
  it("zips headers + values into a typed map", () => {
    const rows = parseRows(SESSIONS, {
      dims: ["sessionSource", "sessionMedium", "date"],
      metrics: ["sessions"],
    });
    expect(rows[0]?.dims["sessionSource"]).toBe("google");
    expect(rows[0]?.metrics["sessions"]).toBe("120");
  });
});

describe("runGa4Poll", () => {
  it("normalizes GA4 reports into canonical events + campaign touchpoints", async () => {
    const eventsInserted: { verb: string; idempotencyKey: string }[] = [];
    const touchpointsInserted: { campaignId: string }[] = [];

    const tx = { execute: vi.fn(async () => undefined) } as never;
    const ga4 = {
      runReport: vi
        .fn()
        .mockResolvedValueOnce(SESSIONS)
        .mockResolvedValueOnce(CONVERSIONS)
        .mockResolvedValueOnce(PAGEVIEWS),
      runRealtimeReport: vi.fn().mockResolvedValue(REALTIME),
    };

    const deps = {
      db: {
        transaction: async <T,>(cb: (t: unknown) => Promise<T>) => cb(tx),
      } as never,
      workspaces: {
        findById: vi.fn(async () => ({
          id: "ws-1",
          settings: {
            source_priority: [],
            enabled_agents: ["marketing_analyst"],
            daily_cost_limit: 100,
            kill_all_agents: false,
            marketing: { ga4_property_id: "p-1" },
          },
        })),
      } as never,
      campaigns: {
        findBySourceMedium: vi.fn(async (_tx: unknown, source: string, medium: string) =>
          source === "google" && medium === "cpc"
            ? { id: "c-1", source, medium }
            : null,
        ),
      } as never,
      touchpoints: {
        insert: vi.fn(async (_tx: unknown, _t: unknown, data: { campaignId: string }) => {
          touchpointsInserted.push({ campaignId: data.campaignId });
          return { id: "tp" };
        }),
      } as never,
      events: {
        insertIfNotExists: vi.fn(
          async (_tx: unknown, _t: unknown, data: { verb: string; idempotencyKey: string }) => {
            eventsInserted.push({ verb: data.verb, idempotencyKey: data.idempotencyKey });
            return { event: { id: "e" }, isNew: true };
          },
        ),
      } as never,
      ga4Factory: () => ga4 as never,
    };

    const result = await runGa4Poll(deps as never, {
      workspaceId: "ws-1",
      serviceAccountJson: "{}",
    });

    expect(result.skipped).toBe(false);
    expect(result.sessions).toBe(200);
    expect(result.conversions).toBe(7);
    expect(result.pageviews).toBe(350);
    expect(result.activeUsersNow).toBe(12);
    // 2 session events + 1 conversion + 1 pageview = 4
    expect(eventsInserted.filter((e) => e.verb === "ga4.session")).toHaveLength(2);
    expect(eventsInserted.filter((e) => e.verb === "ga4.conversion")).toHaveLength(1);
    expect(eventsInserted.filter((e) => e.verb === "ga4.pageview_aggregate")).toHaveLength(1);
    // Only the (google, cpc) row matched a campaign — one touchpoint.
    expect(touchpointsInserted).toEqual([{ campaignId: "c-1" }]);
  });

  it("skips when the workspace has no ga4_property_id", async () => {
    const deps = {
      db: {} as never,
      workspaces: {
        findById: vi.fn(async () => ({
          settings: {
            source_priority: [],
            enabled_agents: [],
            daily_cost_limit: 100,
            kill_all_agents: false,
          },
        })),
      } as never,
      campaigns: {} as never,
      touchpoints: {} as never,
      events: {} as never,
      ga4Factory: () => {
        throw new Error("should not be constructed");
      },
    };
    const result = await runGa4Poll(deps as never, {
      workspaceId: "ws-1",
      serviceAccountJson: "{}",
    });
    expect(result.skipped).toBe(true);
    expect(result.skippedReason).toBe("ga4_property_id_not_configured");
  });
});
