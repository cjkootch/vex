import { describe, expect, it } from "vitest";
import { loadFixture } from "./fixture.js";

describe("eval fixtures", () => {
  const fixture = loadFixture("fixtures");

  it("has 15 entries (10 retrieval + 5 agent)", () => {
    expect(fixture).toHaveLength(15);
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

  it("Sprint-6 agent fixtures (eval_011..015) are present", () => {
    const ids = new Set(fixture.map((e) => e.id));
    for (const expected of ["eval_011", "eval_012", "eval_013", "eval_014", "eval_015"]) {
      expect(ids.has(expected), `missing ${expected}`).toBe(true);
    }
  });
});
