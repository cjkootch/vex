import { describe, expect, it, vi } from "vitest";
import {
  MarketingAnalystAgent,
  computeAnomalies,
  type MarketingMetricSnapshot,
} from "./marketing-analyst.js";
import type { AgentContext } from "./types.js";

const ULID = "01HSEEDWRK0000000000000001";

function snap(
  metric: string,
  value: number,
  windowEnd: string,
  subjectId = ULID,
): MarketingMetricSnapshot {
  return { metric, subjectType: "workspace", subjectId, value, windowEnd };
}

describe("computeAnomalies", () => {
  it("flags out-of-range metrics", () => {
    const history = [10, 12, 11, 13, 9, 10, 11].map((v, i) =>
      snap("ga4.sessions", v, `2026-08-${String(i + 1).padStart(2, "0")}`),
    );
    const current = [snap("ga4.sessions", 250, "2026-08-09")];
    const result = computeAnomalies(current, history);
    expect(result).toHaveLength(1);
    expect(result[0]?.metric).toBe("ga4.sessions");
    expect(result[0]?.direction).toBe("up");
  });

  it("returns nothing when latest is in-range", () => {
    const history = [10, 12, 11, 13, 9, 10, 11].map((v, i) =>
      snap("ga4.sessions", v, `2026-08-${String(i + 1).padStart(2, "0")}`),
    );
    const current = [snap("ga4.sessions", 12, "2026-08-09")];
    expect(computeAnomalies(current, history)).toHaveLength(0);
  });
});

describe("MarketingAnalystAgent", () => {
  it("produces valid ViewManifest summary content + records anomalies", async () => {
    const validManifest = {
      panels: [
        {
          type: "kpi_rail",
          metrics: [
            { label: "Sessions", value: "250" },
            { label: "Conversions", value: "8" },
          ],
        },
        {
          type: "table",
          title: "Campaign breakdown",
          columns: ["campaign", "sessions"],
          rows: [{ campaign: "google/cpc", sessions: "120" }],
        },
      ],
    };

    const summaries: { id: string; payload: string }[] = [];
    const events: { idempotencyKey: string }[] = [];
    let nextId = 0;

    const ctx = {
      tenantId: ULID,
      workspaceId: ULID,
      agentRunId: "run-1",
      tx: {} as unknown,
      anthropic: {
        query: vi.fn(async () => ({
          answer: "Marketing report.",
          viewManifest: validManifest,
          proposedActions: [],
          tokensIn: 100,
          tokensOut: 50,
          cacheReadTokens: 0,
          cacheCreateTokens: 0,
          costUsd: 0.001,
        })),
      },
      summaries: {
        upsert: vi.fn(async (_tx: unknown, _t: unknown, data: { content: string }) => {
          const id = `s-${++nextId}`;
          summaries.push({ id, payload: data.content });
          return { id };
        }),
      },
      events: {
        insertIfNotExists: vi.fn(async (_tx: unknown, _t: unknown, data: { idempotencyKey: string }) => {
          events.push({ idempotencyKey: data.idempotencyKey });
          return { event: { id: "e1" }, isNew: true };
        }),
      },
    } as unknown as AgentContext;

    const history = [10, 12, 11, 13, 9, 10, 11].map((v, i) =>
      snap("ga4.sessions", v, `2026-08-${String(i + 1).padStart(2, "0")}`),
    );
    const agent = new MarketingAnalystAgent({
      current: [snap("ga4.sessions", 250, "2026-08-09")],
      history,
      campaigns: [
        {
          campaignId: "c-1",
          campaign: "google/cpc",
          channel: "cpc",
          sessions: 120,
          conversions: 6,
          clickRate: 0.05,
        },
      ],
    });

    const result = await agent.run(ctx);
    expect(result.costUsd).toBeCloseTo(0.001);
    // 1 overview + 1 campaign summary + at least 1 anomaly event
    expect(summaries.length).toBe(2);
    expect(events.length).toBeGreaterThanOrEqual(1);
    const overviewPayload = JSON.parse(summaries[0]!.payload) as {
      manifest_valid: boolean;
      anomalies: unknown[];
    };
    expect(overviewPayload.manifest_valid).toBe(true);
    expect(overviewPayload.anomalies.length).toBeGreaterThanOrEqual(1);
  });
});
