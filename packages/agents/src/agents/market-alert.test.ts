import { describe, expect, it, vi } from "vitest";
import { MarketAlertAgent } from "./market-alert.js";
import type { AgentContext } from "./types.js";
import type {
  CounterpartyRiskRepository,
  FuelDealRepository,
  FuelMarketRate,
  FuelMarketRateRepository,
} from "@vex/db";

type Mock = ReturnType<typeof vi.fn>;

interface Harness {
  agent: MarketAlertAgent;
  ctx: AgentContext;
  /** All events.insertIfNotExists invocations, in order. */
  events: Array<{ verb: string; idempotencyKey: string; subjectId: string; metadata: Record<string, unknown> }>;
  /** Pending approvals listed into the readiness signal. */
  pendingApprovals: Array<{ actionType: string; proposedPayload: unknown }>;
}

function rate(overrides: Partial<FuelMarketRate> & Pick<FuelMarketRate, "product" | "benchmark" | "pricePerUsg">): FuelMarketRate {
  return {
    id: overrides.id ?? `rate-${overrides.product}-${overrides.benchmark}-${overrides.rateDate ?? "2026-04-17"}`,
    tenantId: overrides.tenantId ?? "tenant",
    rateDate: overrides.rateDate ?? "2026-04-17",
    product: overrides.product,
    benchmark: overrides.benchmark,
    pricePerUsg: overrides.pricePerUsg,
    pricePerBbl: overrides.pricePerBbl ?? overrides.pricePerUsg * 42,
    pricePerMt: overrides.pricePerMt ?? overrides.pricePerUsg * 42 * 7.33,
    currency: overrides.currency ?? "usd",
    source: overrides.source ?? "eia",
    createdAt: overrides.createdAt ?? new Date(),
  };
}

interface HarnessOptions {
  latest: FuelMarketRate[];
  /** Map of "product:benchmark" → prior rates for baseline. */
  range: Record<string, FuelMarketRate[]>;
  /** Deals returned from deals.findByStatus. */
  deals?: Array<{ product: string; buyerOrgId: string; status: string }>;
  /** Counterparty scores keyed by orgId. */
  counterparty?: Record<string, { riskTier: string; compositeScore: number } | null>;
  /** Touchpoints keyed by orgId. */
  touchpoints?: Record<string, Array<{ actor: string | null; occurredAt: Date }>>;
  /** Orgs keyed by orgId for legalName resolution. */
  orgs?: Record<string, { id: string; legalName: string }>;
  /** Buyer deals from deals.findByBuyer. */
  buyerDeals?: Record<string, Array<{ status: string }>>;
  /** Pending approvals — feed for open-follow-up count. */
  pendingApprovals?: Array<{ actionType: string; proposedPayload: unknown }>;
  productMap?: Record<string, string[]>;
  baselineDays?: number;
  thresholdPct?: number;
}

function buildHarness(opts: HarnessOptions): Harness {
  const events: Harness["events"] = [];
  const pending = opts.pendingApprovals ?? [];

  const rates = {
    listLatestPerSeries: vi.fn(async () => opts.latest),
    getRange: vi.fn(async (_tx: unknown, product: string, benchmark: string) => {
      return opts.range[`${product}:${benchmark}`] ?? [];
    }),
    upsert: vi.fn(),
    insert: vi.fn(),
    getLatest: vi.fn(),
    upsertMany: vi.fn(),
    listSince: vi.fn(),
  } as unknown as FuelMarketRateRepository;

  const deals = {
    findByStatus: vi.fn(async () => opts.deals ?? []),
    findByBuyer: vi.fn(async (_tx: unknown, orgId: string) => opts.buyerDeals?.[orgId] ?? []),
  } as unknown as FuelDealRepository;

  const counterparty = {
    score: vi.fn(async (_tx: unknown, orgId: string) => opts.counterparty?.[orgId] ?? null),
  } as unknown as CounterpartyRiskRepository;

  const orgsMap = opts.orgs ?? {};
  const touchpointsMap = opts.touchpoints ?? {};

  const ctx = {
    tenantId: "tenant",
    workspaceId: "ws-1",
    agentRunId: "run-1",
    tx: {} as never,
    anthropic: {} as never,
    openai: {} as never,
    costLedger: {} as never,
    retrieval: {} as never,
    organizations: {
      findById: vi.fn(async (_tx: unknown, id: string) => orgsMap[id] ?? null),
    } as never,
    contacts: {} as never,
    leads: {} as never,
    summaries: {} as never,
    touchpoints: {
      listForOrgSince: vi.fn(async (_tx: unknown, orgId: string) => touchpointsMap[orgId] ?? []),
    } as never,
    activities: {} as never,
    threads: {} as never,
    events: {
      insertIfNotExists: vi.fn(async (_tx: unknown, _tenantId: string, data: { verb: string; idempotencyKey: string; subjectId: string; metadata: Record<string, unknown> }) => {
        events.push({ verb: data.verb, idempotencyKey: data.idempotencyKey, subjectId: data.subjectId, metadata: data.metadata });
        return { event: { id: `evt-${events.length}` }, isNew: true };
      }) as Mock,
    } as never,
    approvals: {
      listByDecision: vi.fn(async () => pending),
    } as never,
    agentRuns: {} as never,
    workspaces: {} as never,
  } as unknown as AgentContext;

  const agent = new MarketAlertAgent({
    rates,
    deals,
    counterparty,
    productMap: opts.productMap ?? { diesel: ["ulsd"], crude: [] },
    ...(opts.baselineDays !== undefined ? { baselineDays: opts.baselineDays } : {}),
    ...(opts.thresholdPct !== undefined ? { thresholdPct: opts.thresholdPct } : {}),
  });

  return { agent, ctx, events, pendingApprovals: pending };
}

describe("MarketAlertAgent", () => {
  it("emits no proposals when no series has enough baseline history", async () => {
    const { agent, ctx } = buildHarness({
      latest: [rate({ product: "diesel", benchmark: "NY_HARBOR_ULSD", pricePerUsg: 3.0 })],
      range: { "diesel:NY_HARBOR_ULSD": [] },
    });
    const out = await agent.run(ctx);
    expect(out.proposedActions).toEqual([]);
    expect(out.rationale).toBe("no threshold crossings");
  });

  it("emits no proposals when the move is below threshold", async () => {
    const prior = Array.from({ length: 10 }, (_, i) =>
      rate({ product: "diesel", benchmark: "NY_HARBOR_ULSD", pricePerUsg: 2.5, rateDate: `2026-04-0${(i % 9) + 1}` }),
    );
    const { agent, ctx } = buildHarness({
      latest: [rate({ product: "diesel", benchmark: "NY_HARBOR_ULSD", pricePerUsg: 2.55, rateDate: "2026-04-17" })],
      range: { "diesel:NY_HARBOR_ULSD": prior },
    });
    const out = await agent.run(ctx);
    expect(out.proposedActions).toHaveLength(0);
  });

  it("proposes T2 market.outreach for a hot buyer on a 7% move (favorable)", async () => {
    // 7% DOWN move — favorable cost basis for a buyer; pushes price
    // favorability into the positive half of the readiness dimension.
    const prior = Array.from({ length: 10 }, (_, i) =>
      rate({ product: "diesel", benchmark: "NY_HARBOR_ULSD", pricePerUsg: 2.5, rateDate: `2026-04-0${(i % 9) + 1}` }),
    );
    const { agent, ctx, events } = buildHarness({
      latest: [rate({ product: "diesel", benchmark: "NY_HARBOR_ULSD", pricePerUsg: 2.325, rateDate: "2026-04-17" })],
      range: { "diesel:NY_HARBOR_ULSD": prior },
      deals: [{ product: "ulsd", buyerOrgId: "org-hot", status: "approved" }],
      counterparty: { "org-hot": { riskTier: "tier_1", compositeScore: 10 } },
      orgs: { "org-hot": { id: "org-hot", legalName: "Hot Buyer Co." } },
      touchpoints: {
        "org-hot": Array.from({ length: 20 }, () => ({ actor: null, occurredAt: new Date() })),
      },
      buyerDeals: {
        "org-hot": [
          { status: "approved" },
          { status: "in_transit" },
        ],
      },
    });

    const out = await agent.run(ctx);

    expect(out.proposedActions).toHaveLength(1);
    const action = out.proposedActions[0]!;
    expect(action.kind).toBe("market.outreach");
    expect(action.tier).toBe("T2");
    expect(action.payload["org_id"]).toBe("org-hot");
    expect(action.payload["direction"]).toBe("down");
    expect(action.payload["readiness_band"]).toBe("hot");

    const crossingEvent = events.find((e) => e.verb === "agent.market_alert.crossing_detected");
    expect(crossingEvent).toBeDefined();
    expect(crossingEvent?.idempotencyKey).toBe(
      "market_alert.crossing:diesel:NY_HARBOR_ULSD:2026-04-17",
    );
  });

  it("blocks outreach when counterparty tier is declined (prohibited)", async () => {
    const prior = Array.from({ length: 10 }, (_, i) =>
      rate({ product: "diesel", benchmark: "NY_HARBOR_ULSD", pricePerUsg: 2.5, rateDate: `2026-04-0${(i % 9) + 1}` }),
    );
    const { agent, ctx } = buildHarness({
      latest: [rate({ product: "diesel", benchmark: "NY_HARBOR_ULSD", pricePerUsg: 2.7, rateDate: "2026-04-17" })],
      range: { "diesel:NY_HARBOR_ULSD": prior },
      deals: [{ product: "ulsd", buyerOrgId: "org-blocked", status: "approved" }],
      counterparty: { "org-blocked": { riskTier: "declined", compositeScore: 90 } },
      orgs: { "org-blocked": { id: "org-blocked", legalName: "Blocked Co." } },
      touchpoints: {
        "org-blocked": Array.from({ length: 20 }, () => ({ actor: null, occurredAt: new Date() })),
      },
    });
    const out = await agent.run(ctx);
    expect(out.proposedActions).toEqual([]);
    const candidates = out.outputRefs["candidates"] as Array<{ proposed: boolean; skipReason?: string }>;
    expect(candidates).toHaveLength(1);
    expect(candidates[0]?.proposed).toBe(false);
    expect(candidates[0]?.skipReason).toBe("counterparty_prohibited");
  });

  it("skips buyers whose readiness lands in the cold band", async () => {
    const prior = Array.from({ length: 10 }, (_, i) =>
      rate({ product: "diesel", benchmark: "NY_HARBOR_ULSD", pricePerUsg: 2.5, rateDate: `2026-04-0${(i % 9) + 1}` }),
    );
    const { agent, ctx } = buildHarness({
      latest: [rate({ product: "diesel", benchmark: "NY_HARBOR_ULSD", pricePerUsg: 2.7, rateDate: "2026-04-17" })],
      range: { "diesel:NY_HARBOR_ULSD": prior },
      deals: [{ product: "ulsd", buyerOrgId: "org-cold", status: "approved" }],
      counterparty: { "org-cold": { riskTier: "tier_3", compositeScore: 80 } },
      orgs: { "org-cold": { id: "org-cold", legalName: "Cold Co." } },
      touchpoints: { "org-cold": [] },
    });
    const out = await agent.run(ctx);
    expect(out.proposedActions).toEqual([]);
    const candidates = out.outputRefs["candidates"] as Array<{ proposed: boolean; skipReason?: string }>;
    expect(candidates[0]?.proposed).toBe(false);
    expect(candidates[0]?.skipReason).toMatch(/^band=(cold|watch)$/);
  });

  it("ignores crossings when no product mapping matches any deal", async () => {
    const prior = Array.from({ length: 10 }, (_, i) =>
      rate({ product: "crude", benchmark: "WTI", pricePerUsg: 1.8, rateDate: `2026-04-0${(i % 9) + 1}` }),
    );
    const { agent, ctx } = buildHarness({
      latest: [rate({ product: "crude", benchmark: "WTI", pricePerUsg: 1.95, rateDate: "2026-04-17" })],
      range: { "crude:WTI": prior },
      // No deals at all → no candidates even though crude:WTI crossed.
      deals: [],
      productMap: { crude: [] },
    });
    const out = await agent.run(ctx);
    expect(out.proposedActions).toEqual([]);
    const crossings = out.outputRefs["crossings"] as Array<{ product: string }>;
    expect(crossings).toHaveLength(1);
    expect(crossings[0]?.product).toBe("crude");
  });
});
