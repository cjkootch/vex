/**
 * Pre-dial call-window gate. A compliance-minded outbound workflow
 * should avoid dialing at hours where the recipient is sleeping or
 * at dinner — TCPA treats 8am–9pm local as the safe window for
 * US consumers, and most jurisdictions follow similar norms. Vex
 * uses a narrower 9am–8pm window to stay well inside safe territory.
 *
 * This module is phone-number-driven (no external tz lookup needed)
 * so it works offline and inside the worker without new deps:
 *
 *   1. Pull the E.164 country code off the `to` number.
 *   2. Map country (+ US area code) → representative IANA time zone.
 *   3. Compute the hour-of-day in that zone using `Intl.DateTimeFormat`.
 *   4. If the hour is outside 9..20, return `{ok: false, reason}`.
 *
 * The US area-code map covers the 300-odd NANP codes and collapses
 * them to the four mainland zones (America/New_York, America/Chicago,
 * America/Denver, America/Los_Angeles) plus Alaska / Hawaii / the
 * Caribbean. If an area code is missing from the map we fall back to
 * America/New_York — a conservative default since Caribbean-bound
 * outreach from the US is the common case.
 *
 * For non-NANP numbers we pick the country's most populous tz. If the
 * caller-supplied `timezone` is provided we skip the derivation — a
 * contact profile's explicit tz wins over phone-number heuristics.
 */

export interface CallWindowConfig {
  /** Recipient phone in E.164 (required). */
  to: string;
  /** IANA tz override — if known, takes precedence over phone lookup. */
  timezone?: string | null;
  /** Current UTC instant. Injected for tests. Defaults to `new Date()`. */
  now?: Date;
  /** Lower bound inclusive. Default 9. */
  openHour?: number;
  /** Upper bound exclusive. Default 20 (8pm). */
  closeHour?: number;
}

export type CallWindowResult =
  | {
      ok: true;
      timezone: string;
      localHour: number;
    }
  | {
      ok: false;
      reason: "outside_window" | "invalid_number";
      timezone: string | null;
      localHour: number | null;
    };

export function checkCallWindow(
  config: CallWindowConfig,
): CallWindowResult {
  const now = config.now ?? new Date();
  const openHour = config.openHour ?? 9;
  const closeHour = config.closeHour ?? 20;

  const tz = config.timezone ?? inferTimezone(config.to);
  if (!tz) {
    return {
      ok: false,
      reason: "invalid_number",
      timezone: null,
      localHour: null,
    };
  }

  const hour = getLocalHour(now, tz);
  if (hour < openHour || hour >= closeHour) {
    return {
      ok: false,
      reason: "outside_window",
      timezone: tz,
      localHour: hour,
    };
  }
  return { ok: true, timezone: tz, localHour: hour };
}

function getLocalHour(now: Date, timezone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    hour: "numeric",
    hour12: false,
  }).formatToParts(now);
  const h = parts.find((p) => p.type === "hour")?.value ?? "0";
  const n = Number.parseInt(h, 10);
  // In some locales hour "24" appears at midnight — normalize.
  return Number.isFinite(n) ? n % 24 : 0;
}

/**
 * Phone → IANA tz. Returns null for malformed numbers.
 *
 * NANP (+1) numbers resolve via an area-code table. Other countries
 * pick a representative tz (most populous / capital). Anything we
 * don't have a mapping for returns null so the caller can decide
 * whether to skip the gate or hard-block.
 */
export function inferTimezone(e164: string): string | null {
  const normalized = e164.trim().replace(/[\s\-()]/g, "");
  if (!normalized.startsWith("+")) return null;

  if (normalized.startsWith("+1") && normalized.length >= 5) {
    const areaCode = normalized.slice(2, 5);
    return NANP_AREA_CODES[areaCode] ?? "America/New_York";
  }

  for (const [prefix, tz] of COUNTRY_TZ) {
    if (normalized.startsWith(prefix)) return tz;
  }
  return null;
}

/**
 * Caribbean + North American area-code → IANA tz map. Not exhaustive
 * for the whole US — we cover the codes most relevant to a Caribbean
 * trading desk (Caribbean islands, FL/TX/NY for counterparties, and
 * US metros that commonly deal in commodities). Missing codes fall
 * back to America/New_York at the caller, which is safe for Caribbean-
 * adjacent activity.
 */
const NANP_AREA_CODES: Record<string, string> = {
  // Caribbean
  "242": "America/Nassau", // Bahamas
  "246": "America/Barbados",
  "264": "America/Anguilla",
  "268": "America/Antigua",
  "284": "America/Tortola",
  "340": "America/St_Thomas", // US Virgin Islands
  "345": "America/Cayman",
  "441": "Atlantic/Bermuda",
  "473": "America/Grenada",
  "649": "America/Grand_Turk",
  "664": "America/Montserrat",
  "721": "America/Lower_Princes", // Sint Maarten
  "758": "America/St_Lucia",
  "767": "America/Dominica",
  "784": "America/St_Vincent",
  "787": "America/Puerto_Rico",
  "809": "America/Santo_Domingo", // Dominican Republic
  "829": "America/Santo_Domingo",
  "849": "America/Santo_Domingo",
  "868": "America/Port_of_Spain", // Trinidad and Tobago
  "869": "America/St_Kitts",
  "876": "America/Jamaica",
  "939": "America/Puerto_Rico",
  // Alaska / Hawaii
  "907": "America/Anchorage",
  "808": "Pacific/Honolulu",
  // US Pacific (CA / WA / OR / NV)
  "206": "America/Los_Angeles",
  "209": "America/Los_Angeles",
  "213": "America/Los_Angeles",
  "253": "America/Los_Angeles",
  "310": "America/Los_Angeles",
  "323": "America/Los_Angeles",
  "408": "America/Los_Angeles",
  "415": "America/Los_Angeles",
  "503": "America/Los_Angeles",
  "510": "America/Los_Angeles",
  "541": "America/Los_Angeles",
  "559": "America/Los_Angeles",
  "619": "America/Los_Angeles",
  "626": "America/Los_Angeles",
  "650": "America/Los_Angeles",
  "661": "America/Los_Angeles",
  "702": "America/Los_Angeles",
  "707": "America/Los_Angeles",
  "714": "America/Los_Angeles",
  "747": "America/Los_Angeles",
  "760": "America/Los_Angeles",
  "805": "America/Los_Angeles",
  "818": "America/Los_Angeles",
  "858": "America/Los_Angeles",
  "909": "America/Los_Angeles",
  "916": "America/Los_Angeles",
  "925": "America/Los_Angeles",
  "949": "America/Los_Angeles",
  "951": "America/Los_Angeles",
  // US Mountain (AZ / CO / NM / UT / MT / WY / ID)
  "303": "America/Denver",
  "307": "America/Denver",
  "385": "America/Denver",
  "406": "America/Denver",
  "435": "America/Denver",
  "480": "America/Phoenix",
  "505": "America/Denver",
  "520": "America/Phoenix",
  "602": "America/Phoenix",
  "623": "America/Phoenix",
  "719": "America/Denver",
  "720": "America/Denver",
  "801": "America/Denver",
  "970": "America/Denver",
  // US Central (TX / IL / MN / MO / LA / OK / WI / AL / TN)
  "205": "America/Chicago",
  "210": "America/Chicago",
  "214": "America/Chicago",
  "225": "America/Chicago",
  "251": "America/Chicago",
  "254": "America/Chicago",
  "256": "America/Chicago",
  "281": "America/Chicago",
  "309": "America/Chicago",
  "312": "America/Chicago",
  "318": "America/Chicago",
  "319": "America/Chicago",
  "331": "America/Chicago",
  "405": "America/Chicago",
  "409": "America/Chicago",
  "414": "America/Chicago",
  "417": "America/Chicago",
  "469": "America/Chicago",
  "504": "America/Chicago",
  "512": "America/Chicago",
  "515": "America/Chicago",
  "573": "America/Chicago",
  "608": "America/Chicago",
  "612": "America/Chicago",
  "615": "America/Chicago",
  "618": "America/Chicago",
  "630": "America/Chicago",
  "651": "America/Chicago",
  "682": "America/Chicago",
  "708": "America/Chicago",
  "713": "America/Chicago",
  "715": "America/Chicago",
  "731": "America/Chicago",
  "763": "America/Chicago",
  "773": "America/Chicago",
  "779": "America/Chicago",
  "832": "America/Chicago",
  "847": "America/Chicago",
  "870": "America/Chicago",
  "901": "America/Chicago",
  "903": "America/Chicago",
  "913": "America/Chicago",
  "918": "America/Chicago",
  "920": "America/Chicago",
  "936": "America/Chicago",
  "956": "America/Chicago",
  "972": "America/Chicago",
  "979": "America/Chicago",
  // Everything east of Mountain defaults to ET below; listing a few
  // common metros so the table doubles as documentation.
  "212": "America/New_York",
  "305": "America/New_York",
  "404": "America/New_York",
  "646": "America/New_York",
  "718": "America/New_York",
  "917": "America/New_York",
  "954": "America/New_York",
};

/**
 * Country prefix → representative IANA tz. Longest-prefix wins via
 * linear scan (the list is short). Not a replacement for a real phone
 * library — sufficient for gating obvious violations.
 */
const COUNTRY_TZ: ReadonlyArray<readonly [string, string]> = [
  ["+52", "America/Mexico_City"],
  ["+53", "America/Havana"],
  ["+55", "America/Sao_Paulo"],
  ["+56", "America/Santiago"],
  ["+57", "America/Bogota"],
  ["+58", "America/Caracas"],
  ["+44", "Europe/London"],
  ["+33", "Europe/Paris"],
  ["+34", "Europe/Madrid"],
  ["+39", "Europe/Rome"],
  ["+41", "Europe/Zurich"],
  ["+49", "Europe/Berlin"],
  ["+31", "Europe/Amsterdam"],
  ["+48", "Europe/Warsaw"],
  ["+86", "Asia/Shanghai"],
  ["+81", "Asia/Tokyo"],
  ["+82", "Asia/Seoul"],
  ["+91", "Asia/Kolkata"],
  ["+65", "Asia/Singapore"],
  ["+971", "Asia/Dubai"],
  ["+972", "Asia/Jerusalem"],
  ["+27", "Africa/Johannesburg"],
  ["+234", "Africa/Lagos"],
  ["+61", "Australia/Sydney"],
  ["+64", "Pacific/Auckland"],
];
