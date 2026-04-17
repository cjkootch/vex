import { describe, expect, it } from "vitest";
import { loadFixture } from "./fixture.js";

describe("eval fixtures", () => {
  const fixture = loadFixture("fixtures");

  it("has 25 entries (10 retrieval + 5 agent + 5 deal + 5 Sprint-13)", () => {
    expect(fixture).toHaveLength(25);
  });

  it("every entry validates against the EvalEntry schema", () => {
    for (const entry of fixture) {
      // Sprint 13 broadened the id pattern to accept topical families
      // (eval_deal_NNN, eval_call_NNN, eval_marketing_NNN, etc.).
      expect(entry.id).toMatch(/^eval_[a-z0-9_]+$/);
      expect(entry.expected_evidence_object_ids.length).toBeGreaterThan(0);
      expect(entry.expected_answer_contains.length).toBeGreaterThan(0);
    }
  });

  it("uses the hybrid retrieval mode by default", () => {
    const modes = new Set(fixture.map((e) => e.retrieval_mode));
    expect(modes).toContain("hybrid");
  });

  it("Sprint-6 agent fixtures (eval_011..015) are present", () => {
    const ids = new Set(fixture.map((e) => e.id));
    for (const expected of ["eval_011", "eval_012", "eval_013", "eval_014", "eval_015"]) {
      expect(ids.has(expected), `missing ${expected}`).toBe(true);
    }
  });

  it("Sprint-11 fuel deal fixtures (eval_deal_001..005) are present", () => {
    const ids = new Set(fixture.map((e) => e.id));
    for (const expected of [
      "eval_deal_001",
      "eval_deal_002",
      "eval_deal_003",
      "eval_deal_004",
      "eval_deal_005",
    ]) {
      expect(ids.has(expected), `missing ${expected}`).toBe(true);
    }
  });

  it("Sprint-13 behavioural fixtures are present", () => {
    const ids = new Set(fixture.map((e) => e.id));
    for (const expected of [
      "eval_call_001",
      "eval_marketing_001",
      "eval_voice_001",
      "eval_isolation_001",
      "eval_cost_limit_001",
    ]) {
      expect(ids.has(expected), `missing ${expected}`).toBe(true);
    }
  });
});
