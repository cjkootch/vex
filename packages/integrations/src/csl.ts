/**
 * Consolidated Screening List (CSL) adapter.
 *
 * The US government publishes a unified daily snapshot of every US
 * sanctions / export-control list at trade.gov:
 *
 *   - Treasury OFAC: SDN, Non-SDN Palestinian Legislative Council
 *     (NS-PLC), Sectoral Sanctions Identifications (SSI), Foreign
 *     Sanctions Evaders (FSE).
 *   - Commerce BIS: Denied Persons List (DPL), Entity List (EL),
 *     Unverified List (UVL), Military End User List (MEU).
 *   - State DDTC: Debarred parties under ITAR (DTC), Nonproliferation
 *     Sanctions (ISN), CAATSA section 231 (CAP).
 *
 * Single JSON file, no API key, no per-query cost — same posture as
 * the legacy OFAC SDN adapter (own the list, control the cadence,
 * no third-party in the critical path), but ~10x the coverage.
 *
 * The adapter intentionally ships the same `screen()` signature as
 * `OFACSdnAdapter` and returns `SdnScreenResult[]` carrying entries
 * that satisfy the `SdnEntry` shape — drop-in replaceable. CSL adds
 * a `sourceList` field on each entry so the audit row + reviewer UI
 * can show which list a hit came from (e.g. BIS Entity List vs OFAC
 * SDN), since reviewers triage them very differently.
 *
 * Shared name normalization + Jaro-Winkler scoring is reused from
 * ofac-sdn.ts via `jaroWinkler`. Keep the fuzzy-match knobs in one
 * place so both adapters score identically.
 */

import { jaroWinkler } from "./ofac-sdn.js";
import type { SdnEntry, SdnMatchType, SdnScreenResult } from "./ofac-sdn.js";

/**
 * CSL list-source short codes. Mirrors the `source_short_name` field
 * trade.gov returns. Stored on the audit row + surfaced in the
 * reviewer UI as a chip so an operator can dismiss list-specific
 * noise (e.g. UVL hits — Unverified List — almost never block deals
 * but ARE caught by the fuzzy matcher).
 */
export type CslSourceList =
  | "SDN" // OFAC Specially Designated Nationals
  | "NS-PLC" // OFAC Non-SDN Palestinian Legislative Council
  | "SSI" // OFAC Sectoral Sanctions Identifications
  | "FSE" // OFAC Foreign Sanctions Evaders
  | "DPL" // BIS Denied Persons List
  | "EL" // BIS Entity List
  | "UVL" // BIS Unverified List
  | "MEU" // BIS Military End User List
  | "DTC" // State ITAR Debarred parties
  | "ISN" // State Nonproliferation Sanctions
  | "CAP" // State CAATSA-related
  | "OTHER";

/**
 * Extension of `SdnEntry` with the CSL-specific `sourceList` tag.
 * Existing callers that only read `SdnEntry` fields keep working
 * unchanged; the agent / UI checks for `sourceList` when it wants
 * to surface which list a hit came from.
 */
export interface CslEntry extends SdnEntry {
  sourceList: CslSourceList;
}

export interface CSLAdapterOptions {
  /** In-memory cache TTL (ms). Defaults to 24h. */
  cacheTtlMs?: number;
  /** CSL JSON URL. Override for tests / air-gapped environments. */
  cslJsonUrl?: string;
  /** Injectable fetch implementation — useful for tests. */
  fetchImpl?: typeof fetch;
}

/**
 * Default snapshot URL. trade.gov publishes a static, cache-friendly
 * JSON dump of the full CSL daily; the search-API endpoint is rate-
 * limited and we don't need its query interface — we screen
 * locally against the parsed list.
 */
const DEFAULT_CSL_URL =
  "https://data.trade.gov/downloadable_consolidated_screening_list/v1/consolidated.json";
const DEFAULT_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

export class CSLAdapter {
  private readonly cacheTtlMs: number;
  private readonly cslJsonUrl: string;
  private readonly fetchImpl: typeof fetch;
  private cache: { entries: CslEntry[]; fetchedAt: number } | null = null;

  constructor(options: CSLAdapterOptions = {}) {
    this.cacheTtlMs = options.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS;
    this.cslJsonUrl = options.cslJsonUrl ?? DEFAULT_CSL_URL;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async getEntries(): Promise<CslEntry[]> {
    const now = Date.now();
    if (this.cache && now - this.cache.fetchedAt < this.cacheTtlMs) {
      return this.cache.entries;
    }
    const response = await this.fetchImpl(this.cslJsonUrl);
    if (!response.ok) {
      throw new Error(
        `CSL fetch failed: ${response.status} ${response.statusText}`,
      );
    }
    const json = (await response.json()) as unknown;
    const entries = parseCslJson(json);
    this.cache = { entries, fetchedAt: now };
    return entries;
  }

  /**
   * Screen a single name. Same semantics as `OFACSdnAdapter.screen`:
   * exact normalized match → score 1.0, otherwise Jaro-Winkler
   * against legal name + every alias on the entry; the highest hit
   * per entry wins. Sorted by score desc.
   *
   * The returned `SdnScreenResult.entry` is a `CslEntry`, so callers
   * who want the source list read `(result.entry as CslEntry).sourceList`.
   */
  screen(
    name: string,
    entries: CslEntry[],
    threshold = 0.85,
  ): SdnScreenResult[] {
    const needle = normalizeName(name);
    if (!needle) return [];
    const results: SdnScreenResult[] = [];
    for (const entry of entries) {
      const legal = [entry.firstName, entry.lastName]
        .filter(Boolean)
        .join(" ");
      const candidates: { text: string; role: "legal" | "alias" }[] = [];
      if (legal) candidates.push({ text: legal, role: "legal" });
      for (const alias of entry.aliases) {
        if (alias) candidates.push({ text: alias, role: "alias" });
      }
      let best: SdnScreenResult | null = null;
      for (const candidate of candidates) {
        const haystack = normalizeName(candidate.text);
        if (!haystack) continue;
        let score: number;
        let matchType: SdnMatchType;
        if (haystack === needle) {
          score = 1;
          matchType = candidate.role === "alias" ? "alias" : "exact";
        } else {
          score = jaroWinkler(needle, haystack);
          matchType = candidate.role === "alias" ? "alias" : "fuzzy";
        }
        if (score < threshold) continue;
        if (!best || score > best.score) {
          best = {
            entry,
            matchedName: candidate.text,
            score,
            matchType,
          };
        }
      }
      if (best) results.push(best);
    }
    results.sort((a, b) => b.score - a.score);
    return results;
  }
}

// ---------------------------------------------------------------------------
// Parser
// ---------------------------------------------------------------------------

/**
 * Parse the CSL JSON snapshot into our internal entry shape. Defensive
 * about field presence — trade.gov occasionally renames or relocates
 * fields and we'd rather drop a single record than fail the whole
 * screen run. Required fields: `id`, `name` (or `last_name`), and a
 * recognisable `type`. Anything else is best-effort.
 */
export function parseCslJson(input: unknown): CslEntry[] {
  if (!input || typeof input !== "object") return [];
  const root = input as Record<string, unknown>;
  const results = root["results"];
  if (!Array.isArray(results)) return [];
  const entries: CslEntry[] = [];
  for (const raw of results) {
    if (!raw || typeof raw !== "object") continue;
    const r = raw as Record<string, unknown>;
    const uid = pickString(r, "id");
    const lastName = pickString(r, "name") ?? pickString(r, "last_name");
    if (!uid || !lastName) continue;
    const sdnType = normalizeCslType(pickString(r, "type"));
    if (!sdnType) continue;
    const firstName = pickString(r, "first_name");
    const remarks = pickString(r, "remarks");
    const programs = pickStringArray(r["programs"]);
    const aliases = extractCslAliases(r);
    const addresses = extractCslAddresses(r);
    const sourceList = normalizeCslSource(
      pickString(r, "source_short_name") ?? pickString(r, "source"),
    );
    entries.push({
      uid,
      ...(firstName ? { firstName } : {}),
      lastName,
      sdnType,
      programs,
      aliases,
      addresses,
      ...(remarks ? { remarks } : {}),
      sourceList,
    });
  }
  return entries;
}

function normalizeCslType(raw: string | undefined): SdnEntry["sdnType"] | null {
  if (!raw) return null;
  const value = raw.trim().toLowerCase();
  if (value === "individual") return "individual";
  if (value === "entity") return "entity";
  if (value === "vessel") return "vessel";
  if (value === "aircraft") return "aircraft";
  return null;
}

/**
 * Map the `source_short_name` field (or full `source` description as
 * fallback) to our internal `CslSourceList` enum. Unknown sources
 * collapse to "OTHER" — callers see the screen still recorded with a
 * usable fallback rather than dropping the row.
 */
function normalizeCslSource(raw: string | undefined): CslSourceList {
  if (!raw) return "OTHER";
  const value = raw.trim().toUpperCase();
  // Direct short-code match.
  if (
    value === "SDN" ||
    value === "NS-PLC" ||
    value === "SSI" ||
    value === "FSE" ||
    value === "DPL" ||
    value === "EL" ||
    value === "UVL" ||
    value === "MEU" ||
    value === "DTC" ||
    value === "ISN" ||
    value === "CAP"
  ) {
    return value as CslSourceList;
  }
  // Fall back to a substring sniff on the long-form description trade.gov
  // sometimes returns instead of (or alongside) the short code.
  if (value.includes("SPECIALLY DESIGNATED NATIONALS")) return "SDN";
  if (value.includes("PALESTINIAN LEGISLATIVE COUNCIL")) return "NS-PLC";
  if (value.includes("SECTORAL SANCTIONS")) return "SSI";
  if (value.includes("FOREIGN SANCTIONS EVADERS")) return "FSE";
  if (value.includes("DENIED PERSONS")) return "DPL";
  if (value.includes("ENTITY LIST")) return "EL";
  if (value.includes("UNVERIFIED LIST")) return "UVL";
  if (value.includes("MILITARY END USER")) return "MEU";
  if (value.includes("ITAR DEBARRED") || value.includes("AECA DEBARRED"))
    return "DTC";
  if (value.includes("NONPROLIFERATION SANCTIONS")) return "ISN";
  if (value.includes("CAATSA")) return "CAP";
  return "OTHER";
}

function extractCslAliases(r: Record<string, unknown>): string[] {
  const aliases = new Set<string>();
  // Two field names trade.gov has used: `alt_names` (current) and
  // `aliases` (older snapshots). Prefer alt_names; fall back to aliases.
  const altNames = r["alt_names"] ?? r["aliases"];
  if (Array.isArray(altNames)) {
    for (const a of altNames) {
      if (typeof a === "string" && a.trim()) aliases.add(a.trim());
    }
  }
  return [...aliases];
}

function extractCslAddresses(r: Record<string, unknown>): string[] {
  const countries = new Set<string>();
  const addrs = r["addresses"];
  if (!Array.isArray(addrs)) return [];
  for (const a of addrs) {
    if (!a || typeof a !== "object") continue;
    const country = (a as Record<string, unknown>)["country"];
    if (typeof country === "string" && country.trim()) {
      countries.add(country.trim());
    }
  }
  return [...countries];
}

function pickString(r: Record<string, unknown>, key: string): string | undefined {
  const v = r[key];
  if (typeof v !== "string") return undefined;
  const trimmed = v.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function pickStringArray(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  const out: string[] = [];
  for (const item of v) {
    if (typeof item === "string" && item.trim()) out.push(item.trim());
  }
  return out;
}

// ---------------------------------------------------------------------------
// Name normalization (mirrors ofac-sdn.ts so both adapters score identically)
// ---------------------------------------------------------------------------

function normalizeName(name: string): string {
  return name
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "") // strip diacritics
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}
