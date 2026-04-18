import { describe, expect, it } from "vitest";
import { evaluateGate, type GateContext, type GateNode } from "./gate-dsl.js";

function baseCtx(overrides: Partial<GateContext> = {}): GateContext {
  return {
    lastIntent: null,
    recentSignals: {
      emailOpens: [],
      emailClicks: [],
      inboundReplies: [],
    },
    enrollmentState: "enrolled",
    now: new Date("2026-04-18T12:00:00Z"),
    ...overrides,
  };
}

describe("evaluateGate", () => {
  it("empty node passes — 'no gate' short-circuit", () => {
    expect(evaluateGate({}, baseCtx()).ok).toBe(true);
    expect(evaluateGate(undefined, baseCtx()).ok).toBe(true);
  });

  it("always / never constants", () => {
    expect(evaluateGate({ always: true }, baseCtx()).ok).toBe(true);
    expect(evaluateGate({ never: true }, baseCtx()).ok).toBe(false);
  });

  it("intent exact match", () => {
    const ctx = baseCtx({ lastIntent: "interested" });
    expect(evaluateGate({ intent: "interested" }, ctx).ok).toBe(true);
    expect(evaluateGate({ intent: "objection" }, ctx).ok).toBe(false);
  });

  it("intent_in set membership", () => {
    const ctx = baseCtx({ lastIntent: "interested" });
    const node: GateNode = { intent_in: ["interested", "neutral"] };
    expect(evaluateGate(node, ctx).ok).toBe(true);
    expect(
      evaluateGate({ intent_in: ["objection"] }, ctx).ok,
    ).toBe(false);
  });

  it("state match", () => {
    expect(
      evaluateGate({ state: "enrolled" }, baseCtx()).ok,
    ).toBe(true);
    expect(evaluateGate({ state: "paused" }, baseCtx()).ok).toBe(false);
  });

  it("opened_in_last_days fires when a recent open is within the window", () => {
    const now = new Date("2026-04-18T12:00:00Z");
    const twoDaysAgo = new Date(now.getTime() - 2 * 24 * 60 * 60 * 1000);
    const tenDaysAgo = new Date(now.getTime() - 10 * 24 * 60 * 60 * 1000);
    const ctx = baseCtx({
      now,
      recentSignals: {
        emailOpens: [tenDaysAgo, twoDaysAgo],
        emailClicks: [],
        inboundReplies: [],
      },
    });
    expect(evaluateGate({ opened_in_last_days: 7 }, ctx).ok).toBe(true);
    expect(evaluateGate({ opened_in_last_days: 1 }, ctx).ok).toBe(false);
  });

  it("clicked_in_last_days + replied_in_last_days use their own buckets", () => {
    const now = new Date();
    const yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1000);
    const ctx = baseCtx({
      now,
      recentSignals: {
        emailOpens: [],
        emailClicks: [yesterday],
        inboundReplies: [yesterday],
      },
    });
    expect(evaluateGate({ clicked_in_last_days: 3 }, ctx).ok).toBe(true);
    expect(evaluateGate({ replied_in_last_days: 3 }, ctx).ok).toBe(true);
    expect(evaluateGate({ opened_in_last_days: 3 }, ctx).ok).toBe(false);
  });

  it("all: passes when every child passes", () => {
    const ctx = baseCtx({ lastIntent: "interested" });
    const node: GateNode = {
      all: [
        { intent: "interested" },
        { state: "enrolled" },
      ],
    };
    expect(evaluateGate(node, ctx).ok).toBe(true);
  });

  it("all: fails when any child fails", () => {
    const ctx = baseCtx({ lastIntent: "interested" });
    const node: GateNode = {
      all: [
        { intent: "interested" },
        { state: "paused" },
      ],
    };
    const r = evaluateGate(node, ctx);
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/state/);
  });

  it("any: passes on first match", () => {
    const ctx = baseCtx({ lastIntent: "objection" });
    const node: GateNode = {
      any: [{ intent: "interested" }, { intent: "objection" }],
    };
    expect(evaluateGate(node, ctx).ok).toBe(true);
  });

  it("any: fails when no child passes", () => {
    const ctx = baseCtx({ lastIntent: "neutral" });
    const node: GateNode = {
      any: [{ intent: "interested" }, { intent: "objection" }],
    };
    expect(evaluateGate(node, ctx).ok).toBe(false);
  });

  it("any: empty children → fail", () => {
    expect(evaluateGate({ any: [] }, baseCtx()).ok).toBe(false);
  });

  it("not: inverts its child", () => {
    const ctx = baseCtx({ lastIntent: "objection" });
    expect(
      evaluateGate({ not: { intent: "interested" } }, ctx).ok,
    ).toBe(true);
    expect(
      evaluateGate({ not: { intent: "objection" } }, ctx).ok,
    ).toBe(false);
  });

  it("unknown operator fails closed (fail-safe on malformed gates)", () => {
    // Cast to any to bypass the narrow typing so the test can
    // simulate bad JSON from the editor.
    const bad = { frobnicate: "x" } as unknown as GateNode;
    const r = evaluateGate(bad, baseCtx());
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/unknown gate op/);
  });

  it("invalid days value fails cleanly rather than running against NaN", () => {
    const node = { opened_in_last_days: -1 } as unknown as GateNode;
    expect(evaluateGate(node, baseCtx()).ok).toBe(false);
  });

  it("real-world: nurture-step gate — warm intent within 14 days", () => {
    const now = new Date();
    const fiveDaysAgo = new Date(now.getTime() - 5 * 24 * 60 * 60 * 1000);
    const ctx = baseCtx({
      now,
      lastIntent: "interested",
      recentSignals: {
        emailOpens: [fiveDaysAgo],
        emailClicks: [],
        inboundReplies: [],
      },
    });
    const gate: GateNode = {
      all: [
        { state: "enrolled" },
        {
          any: [
            { intent_in: ["interested", "neutral"] },
            { opened_in_last_days: 14 },
          ],
        },
      ],
    };
    expect(evaluateGate(gate, ctx).ok).toBe(true);
  });
});
