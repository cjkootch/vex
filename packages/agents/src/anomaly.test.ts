import { describe, expect, it } from "vitest";
import { detectAnomaly } from "./anomaly.js";

describe("detectAnomaly", () => {
  it("returns null when history is too short", () => {
    expect(detectAnomaly({ latest: 5, history: [1, 2, 3] })).toBeNull();
  });

  it("flags a value > 2 std devs above the mean", () => {
    const history = [10, 12, 11, 13, 9, 10, 11];
    const result = detectAnomaly({ latest: 100, history });
    expect(result?.isAnomaly).toBe(true);
    expect(result?.direction).toBe("up");
    expect(result?.zScore).toBeGreaterThan(2);
  });

  it("does not flag a value within 2 std devs", () => {
    const history = [10, 12, 11, 13, 9, 10, 11];
    const result = detectAnomaly({ latest: 12, history });
    expect(result?.isAnomaly).toBe(false);
  });

  it("treats zero variance with non-zero deviation as anomaly", () => {
    const result = detectAnomaly({ latest: 5, history: [1, 1, 1, 1, 1, 1] });
    expect(result?.stdDev).toBe(0);
    expect(result?.isAnomaly).toBe(true);
  });

  it("respects a custom threshold", () => {
    const history = [10, 12, 11, 13, 9, 10, 11];
    // Latest of ~17 is below 2 std devs but above 1.
    expect(
      detectAnomaly({ latest: 17, history, thresholdStdDev: 1 })?.isAnomaly,
    ).toBe(true);
    expect(
      detectAnomaly({ latest: 17, history, thresholdStdDev: 5 })?.isAnomaly,
    ).toBe(false);
  });
});
