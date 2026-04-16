import type { FieldConfidenceEntry } from "./schema/organizations.js";

export type { FieldConfidenceEntry };

/**
 * Confidence threshold at which an incoming value overrides the existing one
 * regardless of source priority. Tuned conservatively — a high-confidence
 * signal from a lower-priority source still has to clear a real gap.
 */
const CONFIDENCE_OVERRIDE_DELTA = 0.2;

/**
 * Lower rank number = higher priority. Sources not in the priority list get
 * rank `Infinity`, i.e. lowest priority.
 */
function rankOf(source: string, sourcePriority: readonly string[]): number {
  const idx = sourcePriority.indexOf(source);
  return idx === -1 ? Number.POSITIVE_INFINITY : idx;
}

/**
 * Decide which of two `FieldConfidenceEntry` values should win.
 *
 * Rules, in order:
 *   1. If the incoming confidence exceeds the existing by more than
 *      {@link CONFIDENCE_OVERRIDE_DELTA}, take the incoming (a strong signal
 *      beats source priority).
 *   2. If the incoming source has a strictly higher priority rank (lower
 *      index in `sourcePriority`), take the incoming.
 *   3. If the sources have the same rank and the incoming has strictly higher
 *      confidence, take the incoming.
 *   4. Otherwise keep the existing.
 */
export function resolveFieldValue(
  existing: FieldConfidenceEntry,
  incoming: FieldConfidenceEntry,
  sourcePriority: readonly string[],
): FieldConfidenceEntry {
  if (incoming.confidence > existing.confidence + CONFIDENCE_OVERRIDE_DELTA) {
    return incoming;
  }

  const existingRank = rankOf(existing.source, sourcePriority);
  const incomingRank = rankOf(incoming.source, sourcePriority);

  if (incomingRank < existingRank) return incoming;
  if (incomingRank === existingRank && incoming.confidence > existing.confidence) {
    return incoming;
  }
  return existing;
}
