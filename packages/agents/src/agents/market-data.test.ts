import { describe, expect, it, vi } from "vitest";
import {
  MarketDataAgent,
  type MarketDataFetchResult,
  type MarketDataProvider,
  type MarketDataSeries,
} from "./market-data.js";
import type { AgentContext } from "./types.js";
import type { FuelMarketRateRepository } from "@vex/db";

interface Harness {
  agent: MarketDataAgent;
  ctx: AgentContext;
  /** Every upsert call (tx, tenantId, data). */
  upserts: Array<Record<string, unknown>>;
  /** Every event.insertIfNotExists call. */
  events: Array<{ verb: string; idempotencyKey: string; metadata: Record<string, unknown> }>;
}

interface HarnessOptions {
  /** `seriesId` → response rows or an Error the adapter throws. */
  responses: Record<string, MarketDataFetchResult[] | Error>;
  series: MarketDataSeries[];
  lookbackDays?: number;
}

function buildHarness(opts: HarnessOptions): Harness {
  const upserts: Harness["upserts"] = [];
  const events: Harness["events"] = [];

  const provider: MarketDataProvider = {
    name: "eia",
    fetchRates: vi.fn(async (params) => {
      const res = opts.responses[params.seriesId];
      if (res instanceof Error) throw res;
      return res ?? [];
    }),
  };

  const rates = {
    upsert: vi.fn(async (_tx: unknown, _tenantId: string, data: Record<string, unknown>) => {
      upserts.push(data);
      return { id: `rate-${upserts.length}`, ...data };
    }),
  } as unknown as FuelMarketRateRepository;

  const ctx = {
    tenantId: "tenant",
    workspaceId: "ws-1",
    agentRunId: "run-1",
    tx: {} as never,
    anthropic: {} as never,
    openai: {} as never,
    costLedger: {} as never,
    retrieval: {} as never,
    organizations: {} as never,
    contacts: {} as never,
    leads: {} as never,
    summaries: {} as never,
    touchpoints: {} as never,
    activities: {} as never,
    threads: {} as never,
    events: {
      insertIfNotExists: vi.fn(async (_tx: unknown, _tenantId: string, data: { verb: string; idempotencyKey: string; metadata: Record<string, unknown> }) => {
        events.push({ verb: data.verb, idempotencyKey: data.idempotencyKey, metadata: data.metadata });
        return { event: { id: `evt-${events.length}` }, isNew: true };
      }),
    } as never,
    approvals: {} as never,
    agentRuns: {} as never,
    workspaces: {} as never,
  } as unknown as AgentContext;

  const agent = new MarketDataAgent({
    provider,
    rates,
    series: opts.series,
    ...(opts.lookbackDays !== undefined ? { lookbackDays: opts.lookbackDays } : {}),
  });
  return { agent, ctx, upserts, events };
}

const CRUDE_WTI: MarketDataSeries = {
  seriesId: "PET.RWTC.D",
  product: "crude",
  benchmark: "WTI",
  nativeUnit: "per_bbl",
  bblPerMt: 7.33,
};

const DIESEL_NY: MarketDataSeries = {
  seriesId: "PET.EER_EPD2D_PF4_Y35NY_DPG.W",
  product: "diesel",
  benchmark: "NY_HARBOR_ULSD",
  nativeUnit: "per_gal",
  bblPerMt: 7.45,
};

describe("MarketDataAgent", () => {
  it("ingests rows, converts units, and upserts into the repository", async () => {
    const { agent, ctx, upserts, events } = buildHarness({
      series: [CRUDE_WTI],
      responses: {
        "PET.RWTC.D": [
          { seriesId: "PET.RWTC.D", period: "2026-04-17", value: 84.0, unit: "dollars per barrel" },
          { seriesId: "PET.RWTC.D", period: "2026-04-16", value: 82.5, unit: "dollars per barrel" },
        ],
      },
    });

    const out = await agent.run(ctx);

    expect(upserts).toHaveLength(2);
    const first = upserts[0]!;
    // per_bbl native → per_usg should be 84/42 = 2.0.
    expect(first["pricePerBbl"]).toBe(84);
    expect(first["pricePerUsg"]).toBeCloseTo(2.0, 6);
    // per_mt = per_bbl * bblPerMt = 84 * 7.33.
    expect(first["pricePerMt"]).toBeCloseTo(84 * 7.33, 2);
    expect(first["source"]).toBe("eia");
    expect(out.internalWrites).toBe(3); // 2 rows + 1 snapshot event
    expect(out.outputRefs["rows_ingested"]).toBe(2);

    const snapshot = events.find((e) => e.verb === "agent.market_data.snapshot_ingested");
    expect(snapshot).toBeDefined();
    expect(snapshot?.idempotencyKey).toMatch(/^market_data:PET\.RWTC\.D:/);
    expect(snapshot?.metadata["rows"]).toBe(2);
  });

  it("converts per_gal series correctly (diesel per_gal → per_bbl = x*42)", async () => {
    const { agent, ctx, upserts } = buildHarness({
      series: [DIESEL_NY],
      responses: {
        "PET.EER_EPD2D_PF4_Y35NY_DPG.W": [
          { seriesId: "PET.EER_EPD2D_PF4_Y35NY_DPG.W", period: "2026-04-17", value: 2.5, unit: "dollars per gallon" },
        ],
      },
    });
    await agent.run(ctx);
    const row = upserts[0]!;
    expect(row["pricePerUsg"]).toBe(2.5);
    expect(row["pricePerBbl"]).toBeCloseTo(2.5 * 42, 4);
    expect(row["pricePerMt"]).toBeCloseTo(2.5 * 42 * 7.45, 2);
  });

  it("skips rows with null values (EIA's '.' placeholder)", async () => {
    const { agent, ctx, upserts } = buildHarness({
      series: [CRUDE_WTI],
      responses: {
        "PET.RWTC.D": [
          { seriesId: "PET.RWTC.D", period: "2026-04-17", value: 84.0, unit: "$/bbl" },
          { seriesId: "PET.RWTC.D", period: "2026-04-16", value: null, unit: "$/bbl" },
          { seriesId: "PET.RWTC.D", period: "2026-04-15", value: 82.5, unit: "$/bbl" },
        ],
      },
    });
    await agent.run(ctx);
    expect(upserts).toHaveLength(2);
  });

  it("survives one provider failure without aborting the other series", async () => {
    const { agent, ctx, upserts, events } = buildHarness({
      series: [CRUDE_WTI, DIESEL_NY],
      responses: {
        "PET.RWTC.D": new Error("EIA 429 rate-limited"),
        "PET.EER_EPD2D_PF4_Y35NY_DPG.W": [
          { seriesId: "PET.EER_EPD2D_PF4_Y35NY_DPG.W", period: "2026-04-17", value: 2.5, unit: "$/gal" },
        ],
      },
    });
    const out = await agent.run(ctx);

    expect(upserts).toHaveLength(1);
    expect(upserts[0]?.["product"]).toBe("diesel");

    const failure = events.find((e) => e.verb === "agent.market_data.fetch_failed");
    expect(failure).toBeDefined();
    expect(failure?.metadata["error"]).toMatch(/EIA 429/);

    // One per-series snapshot event for each (even the failing one).
    const snapshots = events.filter((e) => e.verb === "agent.market_data.snapshot_ingested");
    expect(snapshots).toHaveLength(2);
    expect(out.outputRefs["rows_ingested"]).toBe(1);
  });

  it("uses default 7d lookback when none is supplied", async () => {
    const provider: MarketDataProvider = {
      name: "eia",
      fetchRates: vi.fn(async () => []),
    };
    const rates = { upsert: vi.fn() } as unknown as FuelMarketRateRepository;
    const { ctx } = buildHarness({ series: [CRUDE_WTI], responses: {} });
    const agent = new MarketDataAgent({ provider, rates, series: [CRUDE_WTI] });
    await agent.run(ctx);

    const call = (provider.fetchRates as ReturnType<typeof vi.fn>).mock.calls[0]!;
    const params = call[0] as { start: string; end: string };
    const start = new Date(params.start);
    const end = new Date(params.end);
    const diffMs = end.getTime() - start.getTime();
    const diffDays = Math.round(diffMs / (24 * 60 * 60 * 1000));
    expect(diffDays).toBe(7);
  });
});
