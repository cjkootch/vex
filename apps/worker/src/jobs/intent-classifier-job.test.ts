import { beforeEach, describe, expect, it, vi } from "vitest";
import { runIntentClassifierTick } from "./intent-classifier-job.js";

/**
 * Mock the @vex/db re-export of `withTenant` so the job runs
 * against a stub tx. Repo methods are mocked so the tx itself is
 * never inspected.
 */
vi.mock("@vex/db", async () => {
  const actual = await vi.importActual<Record<string, unknown>>("@vex/db");
  return {
    ...actual,
    withTenant: async (
      _db: unknown,
      _tenantId: string,
      fn: (tx: unknown) => Promise<unknown>,
    ) => fn({ __fake_tx: true }),
  };
});

const TENANT = "01HSEEDWRK0000000000000001";
const TIME = new Date("2026-04-18T14:00:00Z");

interface Tp {
  id: string;
  contactId: string;
  metadata: Record<string, unknown>;
  occurredAt: Date;
}

function buildDeps(opts: {
  candidates: Tp[];
  llmResponse?: string;
  enrollments?: Record<string, Array<{ id: string }>>;
  temporalSignals?: Array<{ workflowId: string; signal: string; payload: unknown }>;
}) {
  const temporalSignals = opts.temporalSignals ?? [];
  return {
    db: {},
    touchpoints: {
      listUnclassifiedInbound: vi.fn().mockResolvedValue(opts.candidates),
      markIntent: vi.fn().mockResolvedValue(undefined),
    },
    enrollments: {
      listActiveForContact: vi.fn(async (_tx: unknown, contactId: string) =>
        opts.enrollments?.[contactId] ?? [],
      ),
    },
    events: {
      insertIfNotExists: vi.fn().mockResolvedValue(undefined),
    },
    anthropic: {
      complete: vi.fn().mockResolvedValue({
        content: [
          {
            type: "text",
            text: opts.llmResponse ?? '{"classifications":[]}',
          },
        ],
        usage: { input_tokens: 10, output_tokens: 20 },
      }),
    },
    temporal: {
      workflow: {
        getHandle: (workflowId: string) => ({
          async signal(signal: string, payload: unknown) {
            temporalSignals.push({ workflowId, signal, payload });
          },
        }),
      },
    },
    now: () => TIME,
  };
}

function asDeps(deps: ReturnType<typeof buildDeps>) {
  return deps as unknown as Parameters<typeof runIntentClassifierTick>[0];
}

function tp(overrides: Partial<Tp> & Pick<Tp, "id">): Tp {
  return {
    id: overrides.id,
    contactId: overrides.contactId ?? "ct1",
    metadata: overrides.metadata ?? { direction: "inbound", text: "" },
    occurredAt: overrides.occurredAt ?? new Date(TIME.getTime() - 3_600_000),
  };
}

describe("runIntentClassifierTick", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("short-circuits when the inbound list is empty (no Claude call)", async () => {
    const deps = buildDeps({ candidates: [] });
    const result = await runIntentClassifierTick(asDeps(deps), {
      tenantId: TENANT,
    });
    expect(result.scanned).toBe(0);
    expect(result.classified).toBe(0);
    expect(deps.anthropic.complete).not.toHaveBeenCalled();
  });

  it("detects 'unsubscribe' via the keyword fast-path without burning tokens", async () => {
    const signals: Array<{ workflowId: string; signal: string; payload: unknown }> = [];
    const deps = buildDeps({
      candidates: [
        tp({
          id: "tp1",
          contactId: "ct1",
          metadata: { direction: "inbound", text: "Please unsubscribe me immediately." },
        }),
      ],
      enrollments: { ct1: [{ id: "e_a" }] },
      temporalSignals: signals,
    });
    const result = await runIntentClassifierTick(asDeps(deps), { tenantId: TENANT });
    expect(result.unsubscribes).toBe(1);
    expect(deps.anthropic.complete).not.toHaveBeenCalled();

    const markCall = deps.touchpoints.markIntent.mock.calls[0]!;
    expect(markCall[2]).toBe("unsubscribe");

    // Signals: one intent_classified + one unsubscribe control, both
    // targeted at the active enrollment's workflow id.
    expect(signals).toHaveLength(2);
    const kinds = signals.map((s) => s.signal);
    expect(kinds).toContain("enrollment.touchpoint");
    expect(kinds).toContain("enrollment.control");
    expect(signals[0]?.workflowId).toBe("campaign-enrollment-e_a");
  });

  it("falls through to Claude for non-keyword replies and writes the label back", async () => {
    const deps = buildDeps({
      candidates: [
        tp({
          id: "tp2",
          contactId: "ct1",
          metadata: {
            direction: "inbound",
            text: "That sounds interesting — can we set up a 15-minute call next week?",
          },
        }),
      ],
      llmResponse: JSON.stringify({
        classifications: [
          {
            id: "tp2",
            intent: "interested",
            confidence: 0.93,
            reason: "asks for a call",
          },
        ],
      }),
    });
    const result = await runIntentClassifierTick(asDeps(deps), { tenantId: TENANT });
    expect(deps.anthropic.complete).toHaveBeenCalledOnce();
    expect(result.classified).toBe(1);
    const markCall = deps.touchpoints.markIntent.mock.calls[0]!;
    expect(markCall[2]).toBe("interested");
    expect(markCall[3]).toBeCloseTo(0.93, 2);
    const event = deps.events.insertIfNotExists.mock.calls[0]![2];
    expect(event.verb).toBe("agent.intent_classified");
  });

  it("below-confidence LLM labels are stored as neutral (with the real label in the reason)", async () => {
    const deps = buildDeps({
      candidates: [
        tp({
          id: "tp3",
          metadata: { direction: "inbound", text: "hmm maybe" },
        }),
      ],
      llmResponse: JSON.stringify({
        classifications: [
          {
            id: "tp3",
            intent: "interested",
            confidence: 0.3,
            reason: "weak signal",
          },
        ],
      }),
    });
    await runIntentClassifierTick(asDeps(deps), { tenantId: TENANT });
    const markCall = deps.touchpoints.markIntent.mock.calls[0]!;
    expect(markCall[2]).toBe("neutral");
    expect(markCall[4]).toMatch(/low-confidence interested/);
  });

  it("unsubscribe bypasses the confidence floor — always commits", async () => {
    const deps = buildDeps({
      candidates: [
        tp({
          id: "tp4",
          metadata: { direction: "inbound", text: "not a match for us, please remove me from the list" },
        }),
      ],
    });
    // This text hits the fast-path ("remove me" regex) — no Claude call.
    await runIntentClassifierTick(asDeps(deps), { tenantId: TENANT });
    const markCall = deps.touchpoints.markIntent.mock.calls[0]!;
    expect(markCall[2]).toBe("unsubscribe");
  });

  it("skips inbound touchpoints with no extractable text", async () => {
    const deps = buildDeps({
      candidates: [
        tp({ id: "tp5", metadata: { direction: "inbound" /* no body/text */ } }),
      ],
    });
    const result = await runIntentClassifierTick(asDeps(deps), { tenantId: TENANT });
    expect(result.skipped).toContain("tp5");
    expect(deps.anthropic.complete).not.toHaveBeenCalled();
    expect(deps.touchpoints.markIntent).not.toHaveBeenCalled();
  });

  it("emits signals to every active enrollment the contact participates in", async () => {
    const signals: Array<{ workflowId: string; signal: string; payload: unknown }> = [];
    const deps = buildDeps({
      candidates: [
        tp({
          id: "tp6",
          contactId: "ct-multi",
          metadata: { direction: "inbound", text: "tell me more about pricing" },
        }),
      ],
      llmResponse: JSON.stringify({
        classifications: [
          {
            id: "tp6",
            intent: "interested",
            confidence: 0.88,
            reason: "asks about pricing",
          },
        ],
      }),
      enrollments: { "ct-multi": [{ id: "e_a" }, { id: "e_b" }, { id: "e_c" }] },
      temporalSignals: signals,
    });
    await runIntentClassifierTick(asDeps(deps), { tenantId: TENANT });
    const enrollmentSignals = signals.filter((s) => s.signal === "enrollment.touchpoint");
    expect(enrollmentSignals).toHaveLength(3);
    const workflowIds = new Set(enrollmentSignals.map((s) => s.workflowId));
    expect(workflowIds.has("campaign-enrollment-e_a")).toBe(true);
    expect(workflowIds.has("campaign-enrollment-e_b")).toBe(true);
    expect(workflowIds.has("campaign-enrollment-e_c")).toBe(true);
  });

  it("works without a Temporal client — labels still land, signal count stays 0", async () => {
    const deps = buildDeps({
      candidates: [
        tp({
          id: "tp7",
          metadata: { direction: "inbound", text: "This is spam, stop." },
        }),
      ],
    });
    (deps as { temporal: unknown }).temporal = null;
    const result = await runIntentClassifierTick(asDeps(deps), { tenantId: TENANT });
    expect(result.classified).toBe(1);
    expect(result.signalsSent).toBe(0);
    expect(deps.touchpoints.markIntent).toHaveBeenCalledOnce();
  });

  it("accepts Claude responses wrapped in markdown code fences", async () => {
    const deps = buildDeps({
      candidates: [
        tp({
          id: "tp8",
          metadata: { direction: "inbound", text: "not right now, maybe Q3" },
        }),
      ],
      llmResponse: "```json\n" + JSON.stringify({
        classifications: [
          {
            id: "tp8",
            intent: "objection",
            confidence: 0.7,
            reason: "timing concern",
          },
        ],
      }) + "\n```",
    });
    await runIntentClassifierTick(asDeps(deps), { tenantId: TENANT });
    const markCall = deps.touchpoints.markIntent.mock.calls[0]!;
    expect(markCall[2]).toBe("objection");
  });
});
