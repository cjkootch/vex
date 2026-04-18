import { describe, expect, it, vi } from "vitest";
import { AnalystAgent } from "./analyst.js";
import type { AgentContext } from "./types.js";

interface Harness {
  agent: AnalystAgent;
  ctx: AgentContext;
  /** Events written via insertIfNotExists. */
  events: Array<{ verb: string; idempotencyKey: string; subjectId: string; metadata: Record<string, unknown> }>;
}

interface FakeTouchpoint {
  campaignId: string | null;
  channel: string;
  metadata: Record<string, unknown>;
}

/**
 * Build a lifecycle touchpoint. The Resend normalizer stores the verb
 * in metadata; the agent reads it from there.
 */
function tp(campaignId: string, verb: string): FakeTouchpoint {
  return {
    campaignId,
    channel: "email",
    metadata: { verb: `email.${verb}` },
  };
}

function repeat<T>(n: number, make: (i: number) => T): T[] {
  return Array.from({ length: n }, (_, i) => make(i));
}

function buildHarness(opts: {
  recent: FakeTouchpoint[];
  prior: FakeTouchpoint[];
}): Harness {
  const events: Harness["events"] = [];

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
    touchpoints: {
      // The agent calls listBetween twice: first for recent, then prior.
      // Feed them in the same order the agent consumes them.
      listBetween: vi
        .fn()
        .mockResolvedValueOnce(opts.recent)
        .mockResolvedValueOnce(opts.prior),
    } as never,
    activities: {} as never,
    threads: {} as never,
    events: {
      insertIfNotExists: vi.fn(async (_tx: unknown, _tenantId: string, data: { verb: string; idempotencyKey: string; subjectId: string; metadata: Record<string, unknown> }) => {
        events.push({
          verb: data.verb,
          idempotencyKey: data.idempotencyKey,
          subjectId: data.subjectId,
          metadata: data.metadata,
        });
        return { event: { id: `evt-${events.length}` }, isNew: true };
      }),
    } as never,
    approvals: {} as never,
    agentRuns: {} as never,
    workspaces: {} as never,
  } as unknown as AgentContext;

  return { agent: new AnalystAgent(), ctx, events };
}

describe("AnalystAgent", () => {
  it("emits no anomalies when recent volume + delivery track prior", async () => {
    // 30 sent + 28 delivered (93%) keeps delivery_rate_drop quiet.
    const healthy = [
      ...repeat(30, () => tp("camp-1", "sent")),
      ...repeat(28, () => tp("camp-1", "delivered")),
    ];
    const { agent, ctx, events } = buildHarness({ recent: healthy, prior: healthy });
    const out = await agent.run(ctx);
    expect(out.internalWrites).toBe(0);
    expect(out.outputRefs["anomalies_detected"]).toBe(0);
    expect(events).toEqual([]);
  });

  it("flags send_volume_drop when recent is < half prior and prior >= 10", async () => {
    const { agent, ctx, events } = buildHarness({
      recent: repeat(2, () => tp("camp-1", "sent")),
      prior: repeat(30, () => tp("camp-1", "sent")),
    });
    const out = await agent.run(ctx);
    expect(out.internalWrites).toBe(1);
    expect(events[0]?.verb).toBe("agent.analyst.anomaly_detected");
    expect(events[0]?.metadata["anomaly_kind"]).toBe("send_volume_drop");
    expect(events[0]?.metadata["severity"]).toBe("warn");
  });

  it("escalates send_volume_drop to critical when recent is zero", async () => {
    const { agent, ctx, events } = buildHarness({
      recent: [],
      prior: repeat(30, () => tp("camp-1", "sent")),
    });
    await agent.run(ctx);
    expect(events[0]?.metadata["anomaly_kind"]).toBe("send_volume_drop");
    expect(events[0]?.metadata["severity"]).toBe("critical");
  });

  it("ignores volume drops on tiny prior weeks (< 10 sent)", async () => {
    const { agent, ctx, events } = buildHarness({
      recent: repeat(1, () => tp("camp-1", "sent")),
      prior: repeat(8, () => tp("camp-1", "sent")),
    });
    await agent.run(ctx);
    expect(events).toEqual([]);
  });

  it("flags bounce_rate_spike when bounce rate climbs > 3pp at ≥10 recent sends", async () => {
    // Recent: 100 sent, 10 bounced → 10% bounce rate.
    // Prior: 100 sent, 3 bounced → 3% bounce rate.
    // Delta = 7pp > 3pp threshold.
    const recent = [
      ...repeat(100, () => tp("camp-1", "sent")),
      ...repeat(10, () => tp("camp-1", "bounced")),
    ];
    const prior = [
      ...repeat(100, () => tp("camp-1", "sent")),
      ...repeat(3, () => tp("camp-1", "bounced")),
    ];
    const { agent, ctx, events } = buildHarness({ recent, prior });
    await agent.run(ctx);
    const spike = events.find((e) => e.metadata["anomaly_kind"] === "bounce_rate_spike");
    expect(spike).toBeDefined();
    expect(spike?.metadata["severity"]).toBe("warn");
  });

  it("escalates bounce_rate_spike to critical when delta > 10pp", async () => {
    const recent = [
      ...repeat(100, () => tp("camp-1", "sent")),
      ...repeat(20, () => tp("camp-1", "bounced")),
    ];
    const prior = [
      ...repeat(100, () => tp("camp-1", "sent")),
      ...repeat(2, () => tp("camp-1", "bounced")),
    ];
    const { agent, ctx, events } = buildHarness({ recent, prior });
    await agent.run(ctx);
    const spike = events.find((e) => e.metadata["anomaly_kind"] === "bounce_rate_spike");
    expect(spike?.metadata["severity"]).toBe("critical");
  });

  it("flags click_rate_collapse when recent CTR is < half prior CTR", async () => {
    // Prior: 100 sent, 10 clicks → 10% CTR. Recent: 100 sent, 2 → 2%. <50% of prior.
    const recent = [
      ...repeat(100, () => tp("camp-1", "sent")),
      ...repeat(2, () => tp("camp-1", "clicked")),
    ];
    const prior = [
      ...repeat(100, () => tp("camp-1", "sent")),
      ...repeat(10, () => tp("camp-1", "clicked")),
    ];
    const { agent, ctx, events } = buildHarness({ recent, prior });
    await agent.run(ctx);
    const collapse = events.find((e) => e.metadata["anomaly_kind"] === "click_rate_collapse");
    expect(collapse).toBeDefined();
  });

  it("flags delivery_rate_drop when deliveries fall below 70% of sends on ≥20", async () => {
    const recent = [
      ...repeat(50, () => tp("camp-1", "sent")),
      ...repeat(30, () => tp("camp-1", "delivered")),
    ];
    const { agent, ctx, events } = buildHarness({
      recent,
      prior: repeat(30, () => tp("camp-1", "sent")),
    });
    await agent.run(ctx);
    const drop = events.find((e) => e.metadata["anomaly_kind"] === "delivery_rate_drop");
    expect(drop).toBeDefined();
    // 30/50 = 60% ≥ 40% → warn, not critical.
    expect(drop?.metadata["severity"]).toBe("warn");
  });

  it("ignores touchpoints without a campaignId", async () => {
    const orphan = { campaignId: null, channel: "email", metadata: { verb: "email.sent" } };
    const { agent, ctx, events } = buildHarness({
      recent: [orphan, orphan, orphan],
      prior: [orphan, ...repeat(30, () => tp("camp-1", "sent"))],
    });
    const out = await agent.run(ctx);
    // Only camp-1 appears in the aggregate — the orphans are dropped on
    // both sides. camp-1 has 0 recent vs 30 prior → send_volume_drop.
    expect(out.outputRefs["campaigns_scanned"]).toBe(1);
    expect(events.filter((e) => e.subjectId === "camp-1")).toHaveLength(1);
  });

  it("idempotency keys include kind + campaign + ISO week", async () => {
    const { agent, ctx, events } = buildHarness({
      recent: repeat(2, () => tp("camp-1", "sent")),
      prior: repeat(30, () => tp("camp-1", "sent")),
    });
    await agent.run(ctx);
    const key = events[0]!.idempotencyKey;
    expect(key).toMatch(/^analyst\.anomaly:send_volume_drop:camp-1:\d{4}-W\d{2}$/);
  });

  it("handles multiple campaigns independently", async () => {
    const healthyB = [
      ...repeat(30, () => tp("camp-b", "sent")),
      ...repeat(28, () => tp("camp-b", "delivered")),
    ];
    const recent = [
      ...repeat(1, () => tp("camp-a", "sent")),   // drop on a
      ...healthyB,                                // stable b
    ];
    const prior = [
      ...repeat(30, () => tp("camp-a", "sent")),
      ...healthyB,
    ];
    const { agent, ctx, events } = buildHarness({ recent, prior });
    await agent.run(ctx);
    const kindsPerCampaign = new Map<string, string[]>();
    for (const e of events) {
      const list = kindsPerCampaign.get(e.subjectId) ?? [];
      list.push(String(e.metadata["anomaly_kind"]));
      kindsPerCampaign.set(e.subjectId, list);
    }
    expect(kindsPerCampaign.get("camp-a")).toContain("send_volume_drop");
    expect(kindsPerCampaign.get("camp-b")).toBeUndefined();
  });
});
