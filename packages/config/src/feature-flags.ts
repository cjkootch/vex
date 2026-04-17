import { createHash } from "node:crypto";

/**
 * Deterministic feature-flag gate used for staged rollouts. Given a
 * tenant id + feature name + rollout percentage, returns true / false
 * consistently: the same tenant either sees the feature every time or
 * never (until the operator bumps the pct). No global randomness, no
 * time dependence — the same input is always the same output.
 *
 * Math:
 *   1. SHA-256 of `${tenantId}:${featureName}`.
 *   2. Read the first four bytes as a big-endian uint32.
 *   3. Modulo 100 → bucket in 0..99.
 *   4. Return `bucket < rolloutPct`.
 *
 * Distribution is uniform enough for rollout decisions even at low
 * percentages — SHA-256 mixes both inputs thoroughly, so a single
 * tenant has independent buckets per feature.
 *
 * Contract edges:
 *   - rolloutPct ≤ 0 → always false
 *   - rolloutPct ≥ 100 → always true
 *   - Non-integer rolloutPct is floored (50.9 behaves as 50)
 *
 * Intended call site: `workspace.settings.feature_rollout[featureName]`
 * holds the pct per feature; this helper is imported directly in the
 * agents / web / api layers so the behaviour stays consistent across
 * every runtime.
 */
export function isFeatureEnabled(
  featureName: string,
  tenantId: string,
  rolloutPct: number,
): boolean {
  if (!Number.isFinite(rolloutPct) || rolloutPct <= 0) return false;
  if (rolloutPct >= 100) return true;
  const clamped = Math.floor(rolloutPct);
  const bucket = featureBucket(tenantId, featureName);
  return bucket < clamped;
}

/**
 * Exposed for telemetry / debugging — lets an operator see which
 * bucket a tenant landed in for a feature without also evaluating
 * the current pct. The bucket is stable for the lifetime of the
 * (tenantId, featureName) pair.
 */
export function featureBucket(tenantId: string, featureName: string): number {
  const hash = createHash("sha256")
    .update(`${tenantId}:${featureName}`)
    .digest();
  // First four bytes of the digest as an unsigned 32-bit integer.
  const u32 = hash.readUInt32BE(0);
  return u32 % 100;
}
