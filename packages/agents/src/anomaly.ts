/**
 * Rolling-average anomaly detection. Produces a flag when the latest value
 * deviates by more than `thresholdStdDev` (default 2) standard deviations
 * from the preceding window's mean.
 *
 * Design notes:
 *   - We operate on a single numeric series; callers aggregate per metric
 *     (sessions, conversions, click-rate, etc.) before calling this.
 *   - The history window is expected to be ≥5 samples; below that we
 *     return null (not enough signal to trigger).
 *   - Zero std-dev (all-same history) is treated as "no variance"; any
 *     deviation in the latest value is still flagged as long as the
 *     difference is non-zero.
 */

export interface AnomalyInput {
  /** Latest observation (the value under test). */
  latest: number;
  /** Historical window, oldest-first. Should NOT contain `latest`. */
  history: readonly number[];
  /** Z-score threshold; default 2.0. */
  thresholdStdDev?: number;
}

export interface AnomalyResult {
  isAnomaly: boolean;
  zScore: number;
  mean: number;
  stdDev: number;
  direction: "up" | "down" | "flat";
}

export function detectAnomaly(input: AnomalyInput): AnomalyResult | null {
  if (input.history.length < 5) return null;
  const threshold = input.thresholdStdDev ?? 2;
  const mean = input.history.reduce((a, b) => a + b, 0) / input.history.length;
  const variance =
    input.history.reduce((acc, v) => acc + (v - mean) * (v - mean), 0) /
    input.history.length;
  const stdDev = Math.sqrt(variance);
  const diff = input.latest - mean;
  const direction: AnomalyResult["direction"] =
    diff > 0 ? "up" : diff < 0 ? "down" : "flat";

  if (stdDev === 0) {
    return {
      isAnomaly: diff !== 0,
      zScore: diff === 0 ? 0 : Number.POSITIVE_INFINITY * Math.sign(diff),
      mean,
      stdDev,
      direction,
    };
  }
  const zScore = diff / stdDev;
  return {
    isAnomaly: Math.abs(zScore) > threshold,
    zScore,
    mean,
    stdDev,
    direction,
  };
}
