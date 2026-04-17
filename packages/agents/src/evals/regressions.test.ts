import { describe, expect, it } from "vitest";
import { computeRegressions } from "./regressions.js";

describe("computeRegressions", () => {
  it("returns [] when there's no previous run", () => {
    expect(
      computeRegressions(null, [
        { id: "eval_001", passed: false },
        { id: "eval_002", passed: true },
      ]),
    ).toEqual([]);
  });

  it("returns [] when nothing regressed", () => {
    const prev = [
      { id: "eval_001", passed: true },
      { id: "eval_002", passed: true },
      { id: "eval_003", passed: false },
    ];
    const now = [
      { id: "eval_001", passed: true },
      { id: "eval_002", passed: true },
      { id: "eval_003", passed: true }, // improved — not a regression
    ];
    expect(computeRegressions(prev, now)).toEqual([]);
  });

  it("flags a fixture that passed before and fails now", () => {
    const prev = [
      { id: "eval_001", passed: true },
      { id: "eval_002", passed: true },
      { id: "eval_003", passed: true },
    ];
    const now = [
      { id: "eval_001", passed: true },
      { id: "eval_002", passed: false }, // regression
      { id: "eval_003", passed: true },
    ];
    expect(computeRegressions(prev, now)).toEqual(["eval_002"]);
  });

  it("does not flag fixtures that failed on the previous run too", () => {
    const prev = [
      { id: "eval_001", passed: false },
      { id: "eval_002", passed: true },
    ];
    const now = [
      { id: "eval_001", passed: false },
      { id: "eval_002", passed: false },
    ];
    // eval_001 was already failing; only eval_002 is a regression.
    expect(computeRegressions(prev, now)).toEqual(["eval_002"]);
  });

  it("does not flag newly-added fixtures", () => {
    const prev = [{ id: "eval_001", passed: true }];
    const now = [
      { id: "eval_001", passed: true },
      { id: "eval_new_001", passed: false }, // new, not a regression
    ];
    expect(computeRegressions(prev, now)).toEqual([]);
  });

  it("handles an empty previous list as 'no baseline'", () => {
    const now = [{ id: "eval_001", passed: false }];
    expect(computeRegressions([], now)).toEqual([]);
  });

  it("returns the regressions sorted so the admin UI list is stable", () => {
    const prev = [
      { id: "eval_c", passed: true },
      { id: "eval_a", passed: true },
      { id: "eval_b", passed: true },
    ];
    const now = [
      { id: "eval_c", passed: false },
      { id: "eval_a", passed: false },
      { id: "eval_b", passed: false },
    ];
    expect(computeRegressions(prev, now)).toEqual([
      "eval_a",
      "eval_b",
      "eval_c",
    ]);
  });
});
