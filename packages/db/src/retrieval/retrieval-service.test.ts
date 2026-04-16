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
