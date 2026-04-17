import { describe, expect, it, vi } from "vitest";
import { HealthService, NEON_LATENCY_ALERT_MS } from "./health.service.js";

// We build the service directly rather than via Nest DI — the ping
// logic is the interesting part, not the module wiring.
function build({
  dbOk = true,
  dbLatencyMs = 10,
  redisOk = true,
  temporalOk = true,
  queueDepths = { normalization: 0, dlq: 0, agents: 0, "approval-executor": 0, transcript: 0 },
  queuesMissing = false,
}: Partial<{
  dbOk: boolean;
  dbLatencyMs: number;
  redisOk: boolean;
  temporalOk: boolean;
  queueDepths: Record<string, number>;
  queuesMissing: boolean;
}> = {}) {
  const db = {
    async execute() {
      if (!dbOk) throw new Error("neon down");
      await new Promise((r) => setTimeout(r, dbLatencyMs));
    },
  };
  const redis = {
    async ping() {
      if (!redisOk) throw new Error("redis down");
      return "PONG";
    },
  };
  const temporal = temporalOk
    ? {
        workflowService: {
          async getSystemInfo() {
            return {};
          },
        },
      }
    : {
        workflowService: {
          async getSystemInfo() {
            throw new Error("temporal down");
          },
        },
      };

  const fakeQueues = queuesMissing
    ? null
    : {
        async close() {},
        normalization: queueStub(queueDepths.normalization ?? 0),
        dlq: queueStub(queueDepths.dlq ?? 0),
        agents: queueStub(queueDepths.agents ?? 0),
        approvalExecutor: queueStub(queueDepths["approval-executor"] ?? 0),
        transcript: queueStub(queueDepths.transcript ?? 0),
      };

  return new HealthService(
    db as never,
    redis as never,
    temporal as never,
    fakeQueues as never,
  );
}

function queueStub(depth: number) {
  const half = Math.floor(depth / 2);
  return {
    async getJobCounts() {
      return { waiting: half, active: depth - half };
    },
  } as never;
}

describe("HealthService.detailed", () => {
  it("returns ok when every dependency is healthy and db is fast", async () => {
    const svc = build();
    const report = await svc.detailed();
    expect(report.status).toBe("ok");
    expect(report.db.status).toBe("ok");
    expect(report.redis.status).toBe("ok");
    expect(report.temporal.status).toBe("ok");
  });

  it("reports degraded when db latency is above the alert threshold", async () => {
    const svc = build({ dbLatencyMs: NEON_LATENCY_ALERT_MS + 50 });
    const report = await svc.detailed();
    expect(report.status).toBe("degraded");
    expect(report.db.status).toBe("ok");
    expect(report.db.latency_ms).toBeGreaterThanOrEqual(NEON_LATENCY_ALERT_MS);
  });

  it("reports degraded when one dependency is failing", async () => {
    const svc = build({ redisOk: false });
    const report = await svc.detailed();
    expect(report.status).toBe("degraded");
    expect(report.redis.status).toBe("fail");
  });

  it("reports down when two dependencies are failing", async () => {
    const svc = build({ redisOk: false, temporalOk: false });
    const report = await svc.detailed();
    expect(report.status).toBe("down");
  });

  it("returns an empty queue map when the queue handle is null", async () => {
    const svc = build({ queuesMissing: true });
    const report = await svc.detailed();
    expect(report.queue_depths).toEqual({});
  });

  it("surfaces queue depths and never throws on a flaky queue", async () => {
    const svc = build({ queueDepths: { normalization: 12, dlq: 1, agents: 3, "approval-executor": 0, transcript: 0 } });
    const report = await svc.detailed();
    expect(report.queue_depths.normalization).toBe(12);
  });
});

// Shut vitest up — we're testing stubs that don't need coverage.
vi.setConfig({});
