/**
 * Default quiet-hours window: outbound messaging and calling is
 * blocked when the recipient's local time falls outside [08:00, 21:00).
 *
 * Pure function — keeps the Sprint B executor branches testable
 * without a clock mock. A future sprint will read per-workspace
 * overrides; for now operators get a single sensible default so
 * nothing sends a 2am SMS to a customer.
 */

export interface QuietHoursOptions {
  /** Lower bound in local time. Default 8 (08:00). */
  startHour?: number;
  /** Upper bound in local time, exclusive. Default 21 (21:00). */
  endHour?: number;
}

export interface QuietHoursDecision {
  ok: boolean;
  /** Machine-readable reason when `ok === false`. */
  reason?: "quiet_hours" | "invalid_timezone";
  /** The local hour we evaluated against, for audit metadata. */
  localHour: number;
  /** Resolved IANA tz the decision used. */
  timezone: string;
}

const DEFAULT_START = 8;
const DEFAULT_END = 21;

/**
 * Decide whether outbound contact is allowed right now for a recipient
 * in the given IANA timezone. Falls back to `UTC` when the timezone
 * is unknown and returns `invalid_timezone` so callers can surface
 * why it blocked.
 */
export function canContactNow(
  now: Date,
  timezone: string | null | undefined,
  options: QuietHoursOptions = {},
): QuietHoursDecision {
  const startHour = options.startHour ?? DEFAULT_START;
  const endHour = options.endHour ?? DEFAULT_END;
  const tz = timezone ?? "UTC";

  let localHour: number;
  try {
    const formatter = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      hour: "numeric",
      hour12: false,
    });
    const parts = formatter.formatToParts(now);
    const hourPart = parts.find((p) => p.type === "hour");
    localHour = hourPart ? Number.parseInt(hourPart.value, 10) : NaN;
    // `formatToParts` can emit "24" for midnight under some ICU builds;
    // normalise to [0, 23].
    if (localHour === 24) localHour = 0;
  } catch {
    return {
      ok: false,
      reason: "invalid_timezone",
      localHour: NaN,
      timezone: tz,
    };
  }

  if (!Number.isFinite(localHour)) {
    return {
      ok: false,
      reason: "invalid_timezone",
      localHour: NaN,
      timezone: tz,
    };
  }

  // Normal window: start < end. Wrap-around windows aren't supported
  // today — "quiet hours" is the complement of a single daytime band.
  const inWindow = localHour >= startHour && localHour < endHour;
  if (inWindow) {
    return { ok: true, localHour, timezone: tz };
  }
  return {
    ok: false,
    reason: "quiet_hours",
    localHour,
    timezone: tz,
  };
}
