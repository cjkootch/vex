import { describe, expect, it } from "vitest";
import { featureBucket, isFeatureEnabled } from "./feature-flags.js";

describe("isFeatureEnabled", () => {
  it("returns false when rolloutPct is 0 regardless of bucket", () => {
    for (let i = 0; i < 10; i++) {
      expect(isFeatureEnabled("f", `tenant-${i}`, 0)).toBe(false);
    }
  });

  it("returns true when rolloutPct is 100 regardless of bucket", () => {
    for (let i = 0; i < 10; i++) {
      expect(isFeatureEnabled("f", `tenant-${i}`, 100)).toBe(true);
    }
  });

  it("handles rolloutPct > 100 as always true", () => {
    expect(isFeatureEnabled("f", "tenant-1", 120)).toBe(true);
  });

  it("handles negative or NaN rolloutPct as always false", () => {
    expect(isFeatureEnabled("f", "tenant-1", -5)).toBe(false);
    expect(isFeatureEnabled("f", "tenant-1", Number.NaN)).toBe(false);
  });

  it("is deterministic — same input returns same result across calls", () => {
    const input: Array<[string, string, number]> = [
      ["voice_alpha", "01HSEEDWRK0000000000000001", 42],
      ["pstn_calls", "01HSEEDWRK0000000000000001", 42],
      ["deal_canvas", "tenant-xyz", 10],
    ];
    for (const [feature, tenant, pct] of input) {
      const first = isFeatureEnabled(feature, tenant, pct);
      for (let i = 0; i < 25; i++) {
        expect(isFeatureEnabled(feature, tenant, pct)).toBe(first);
      }
    }
  });

  it("floors a non-integer rolloutPct", () => {
    // Find a tenant with bucket exactly 50, assert pct=50 excludes
    // it (strict <) and pct=50.9 still excludes it (floored to 50).
    const tenant = "tenant-" + findBucketedTenant(50);
    expect(featureBucket(tenant, "flag")).toBe(50);
    expect(isFeatureEnabled("flag", tenant, 50)).toBe(false);
    expect(isFeatureEnabled("flag", tenant, 50.9)).toBe(false);
    expect(isFeatureEnabled("flag", tenant, 51)).toBe(true);
  });

  it("produces a roughly uniform distribution over 10k tenants at 50%", () => {
    let enabled = 0;
    for (let i = 0; i < 10_000; i++) {
      if (isFeatureEnabled("voice_alpha", `tenant-${i}`, 50)) enabled++;
    }
    // Expect ~5000; allow 400 slack for the 10k sample.
    expect(enabled).toBeGreaterThan(4_600);
    expect(enabled).toBeLessThan(5_400);
  });

  it("different feature names for the same tenant are independent", () => {
    // A tenant can be in the 10% rollout for one feature and the
    // 90% rollout for another — asserting the buckets aren't equal
    // for at least some pair proves the mixing actually happens.
    const tenant = "01HSEEDWRK0000000000000001";
    const bucketA = featureBucket(tenant, "voice_alpha");
    const bucketB = featureBucket(tenant, "pstn_calls");
    const bucketC = featureBucket(tenant, "deal_canvas");
    const distinct = new Set([bucketA, bucketB, bucketC]);
    expect(distinct.size).toBeGreaterThanOrEqual(2);
  });
});

/**
 * Small helper — find the first `n` suffix such that the bucket for
 * `tenant-${n}:flag` is exactly `target`. The test assertion above
 * uses this so we never depend on implementation details of the hash
 * while still testing a specific bucket value.
 */
function findBucketedTenant(target: number): number {
  for (let i = 0; i < 50_000; i++) {
    if (featureBucket(`tenant-${i}`, "flag") === target) return i;
  }
  throw new Error(`no tenant with bucket=${target} found in 50k samples`);
}
