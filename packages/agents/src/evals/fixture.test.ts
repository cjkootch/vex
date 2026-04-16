import { describe, expect, it } from "vitest";
import { loadFixture } from "./fixture.js";

describe("sprint1 eval fixture", () => {
  const fixture = loadFixture("sprint1");

  it("has exactly 10 entries", () => {
    expect(fixture).toHaveLength(10);
  });

  it("every entry validates against the EvalEntry schema", () => {
    for (const entry of fixture) {
      expect(entry.id).toMatch(/^eval_\d{3}$/);
      expect(entry.expected_evidence_object_ids.length).toBeGreaterThan(0);
      expect(entry.expected_answer_contains.length).toBeGreaterThan(0);
    }
  });

  it("uses the hybrid retrieval mode by default", () => {
    const modes = new Set(fixture.map((e) => e.retrieval_mode));
    expect(modes).toContain("hybrid");
  });
});
