import { describe, expect, it } from "vitest";
import type { EvidenceItem, EvidencePack } from "@vex/domain";
import { __test } from "./retrieval-service.js";

const baseItem = (overrides: Partial<EvidenceItem>): EvidenceItem => ({
  chunk_id: "c1",
  object_type: "organization",
  object_id: "o1",
  chunk_text: "x".repeat(100),
  source_ref: "ref",
  source_type: "chunk",
  occurred_at: new Date("2026-04-15T00:00:00Z"),
  freshness_hours: 12,
  confidence_score: 0.7,
  corroborated_by_count: 0,
  permission_scope: "workspace",
  raw_event_ref: null,
  summary_version: null,
  ...overrides,
});

describe("rerankScore", () => {
  it("rewards high-confidence corroborated fresh evidence over a stale weak hit", () => {
    const fresh = baseItem({ confidence_score: 0.95, corroborated_by_count: 5, freshness_hours: 1 });
    const stale = baseItem({ confidence_score: 0.3, corroborated_by_count: 0, freshness_hours: 24 * 30 });
    const rrf = 0.01;
    expect(__test.rerankScore(rrf, fresh)).toBeGreaterThan(__test.rerankScore(rrf, stale));
  });

  it("normalizedRrf maps to [0,1]", () => {
    expect(__test.normalizedRrf(0)).toBe(0);
    expect(__test.normalizedRrf(1)).toBe(1);
    expect(__test.normalizedRrf(0.005)).toBeGreaterThan(0);
  });
});

describe("truncateToCap", () => {
  it("keeps the freshest items first when over budget", () => {
    const newer = baseItem({ chunk_id: "newer", occurred_at: new Date("2026-04-20") });
    const older = baseItem({ chunk_id: "older", occurred_at: new Date("2026-01-01") });
    const pack: EvidencePack = {
      summaries: [],
      items: [older, newer],
      estimated_tokens: 1_000_000,
    };
    const truncated = __test.truncateToCap(pack, 30);
    // Each chunk_text is 100 chars ≈ 25 tokens, so only one fits under 30.
    expect(truncated.items).toHaveLength(1);
    expect(truncated.items[0]?.chunk_id).toBe("newer");
  });
});

describe("hasProcurContext", () => {
  it("returns false for empty / undefined / null", () => {
    expect(__test.hasProcurContext(null)).toBe(false);
    expect(__test.hasProcurContext(undefined)).toBe(false);
    expect(__test.hasProcurContext({})).toBe(false);
  });

  it("returns false when only legacy fields are present", () => {
    expect(
      __test.hasProcurContext({
        productSpecs: [{ property: "Cetane", typical: "52" }],
      }),
    ).toBe(false);
  });

  it("returns true for any of the new context fields", () => {
    expect(__test.hasProcurContext({ pushReason: "active match" })).toBe(true);
    expect(
      __test.hasProcurContext({
        signals: [
          {
            kind: "rfq",
            occurredAt: "2026-04-15",
            source: "https://procur.example/rfq/9",
            narrative: "Filed RFQ for ULSD",
          },
        ],
      }),
    ).toBe(true);
    expect(
      __test.hasProcurContext({
        matchQueue: { score: 0.8, reasons: ["category match"] },
      }),
    ).toBe(true);
    expect(
      __test.hasProcurContext({
        ownership: {
          parents: [{ orgKey: "parent-1", distance: 1 }],
        },
      }),
    ).toBe(true);
  });

  it("treats blank-string pushReason as absent", () => {
    expect(__test.hasProcurContext({ pushReason: "   " })).toBe(false);
  });
});

describe("renderProcurContextChunk", () => {
  it("renders pushReason, match queue, and signals into a single-block chunk", () => {
    const text = __test.renderProcurContextChunk("L_123", {
      pushReason:
        "Buyer filed three Caribbean ULSD tenders in 14 days; ICP-aligned.",
      matchQueue: {
        score: 0.82,
        reasons: ["category match", "fresh awards"],
      },
      signals: [
        {
          kind: "rfq",
          occurredAt: "2026-04-15",
          source: "https://procur.example/rfq/9",
          narrative: "RFQ #9 — 2M USG ULSD into Pointe-à-Pitre",
          weight: 0.9,
        },
      ],
    });
    expect(text).toContain("Procur context for lead L_123:");
    expect(text).toContain("Push reason: Buyer filed three");
    expect(text).toContain("Match-queue score: 82/100");
    expect(text).toContain("category match; fresh awards");
    expect(text).toContain("[rfq @ 2026-04-15]");
    expect(text).toContain("RFQ #9");
    expect(text).toContain("(weight 0.90)");
  });

  it("renders ownership parents and subsidiaries when present", () => {
    const text = __test.renderProcurContextChunk("L_456", {
      ownership: {
        parents: [
          { orgKey: "p-1", legalName: "Parent Holdings", role: "100% owner", distance: 1 },
        ],
        subsidiaries: [{ orgKey: "s-1", legalName: "Sub Trading", distance: 1 }],
      },
    });
    expect(text).toContain("Parents: Parent Holdings (100% owner)");
    expect(text).toContain("Subsidiaries: Sub Trading");
  });

  it("caps signals at 5 entries", () => {
    const signals = Array.from({ length: 8 }, (_, i) => ({
      kind: "news" as const,
      occurredAt: `2026-04-${String(i + 1).padStart(2, "0")}`,
      source: `https://procur.example/${i}`,
      narrative: `signal ${i}`,
    }));
    const text = __test.renderProcurContextChunk("L_capped", { signals });
    expect((text.match(/\[news @/g) ?? []).length).toBe(5);
  });
});
