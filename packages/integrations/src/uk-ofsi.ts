/**
 * UK OFSI Consolidated Sanctions Targets adapter.
 *
 * The UK Office of Financial Sanctions Implementation publishes a
 * consolidated CSV of every UK-imposed financial-sanctions target
 * at:
 *
 *   https://ofsistorage.blob.core.windows.net/publishlive/2022format/ConList.csv
 *
 * (The legacy `ConList.xlsx` is also published; we ingest the CSV
 * because parsing CSV is a few lines of code and avoids pulling
 * an XLSX-parser dep into the compliance critical path.)
 *
 * Updated typically twice weekly; we cache for 72h to align with
 * that cadence (vs the 24h cache other adapters use for daily
 * publishers). Free, no API key.
 *
 * Why a separate adapter from EU/CSL: UK left the EU and now
 * maintains its own list with its own regime classification
 * (`Russia`, `Belarus`, `Counter-Terrorism`, `ISIL (Da'esh) and
 * Al-Qaida`, …). Names overlap heavily with EU + OFAC but the
 * UK row carries its own group ID (`Group Type`, `Group ID`)
 * and listing date that compliance owners reference directly. A
 * UK-only screening posture is the right surface for UK
 * operators who specifically need OFSI clearance and don't want
 * EU/CSL noise in their queue.
 *
 * Parser is hand-rolled. The CSV is `,`-delimited with `"`-quoted
 * fields and supports `""` as an embedded quote. ~25 lines of
 * code; a `csv-parse` dep would pull a transitive surface for one
 * consumer.
 */

import { jaroWinkler } from "./ofac-sdn.js";
import type { SdnEntry, SdnMatchType, SdnScreenResult } from "./ofac-sdn.js";

export interface UkOfsiEntry extends SdnEntry {
  sourceList: "UK_OFSI";
}

export interface UKOFSIAdapterOptions {
  /**
   * In-memory cache TTL (ms). Defaults to 72h to align with OFSI's
   * twice-weekly publish cadence — daily refresh would just re-pay
   * the network cost on a list that hasn't moved.
   */
  cacheTtlMs?: number;
  /** OFSI CSV URL. Override for tests / air-gapped environments. */
  ofsiCsvUrl?: string;
  /** Injectable fetch implementation — useful for tests. */
  fetchImpl?: typeof fetch;
}

const DEFAULT_OFSI_URL =
  "https://ofsistorage.blob.core.windows.net/publishlive/2022format/ConList.csv";
const DEFAULT_CACHE_TTL_MS = 72 * 60 * 60 * 1000;

export class UKOFSIAdapter {
  private readonly cacheTtlMs: number;
  private readonly ofsiCsvUrl: string;
  private readonly fetchImpl: typeof fetch;
  private cache: { entries: UkOfsiEntry[]; fetchedAt: number } | null = null;

  constructor(options: UKOFSIAdapterOptions = {}) {
    this.cacheTtlMs = options.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS;
    this.ofsiCsvUrl = options.ofsiCsvUrl ?? DEFAULT_OFSI_URL;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async getEntries(): Promise<UkOfsiEntry[]> {
    const now = Date.now();
    if (this.cache && now - this.cache.fetchedAt < this.cacheTtlMs) {
      return this.cache.entries;
    }
    const response = await this.fetchImpl(this.ofsiCsvUrl);
    if (!response.ok) {
      throw new Error(
        `UK OFSI fetch failed: ${response.status} ${response.statusText}`,
      );
    }
    const csv = await response.text();
    const entries = parseUkOfsiCsv(csv);
    this.cache = { entries, fetchedAt: now };
    return entries;
  }

  /**
   * Same `screen()` semantics as the OFAC SDN / CSL / EU adapters.
   * OFSI rows tend to carry many aliases per target so the per-entry
   * "highest scoring candidate" pass is doing meaningful work; a
   * legal-name-only check would miss most of OFSI's value.
   */
  screen(
    name: string,
    entries: UkOfsiEntry[],
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
// CSV parser
// ---------------------------------------------------------------------------

/**
 * OFSI CSV columns we read (the 2022-format CSV ships ~30 columns;
 * we map a focused subset). Extra columns are tolerated.
 *
 *   Group ID     → groups multiple rows that describe the same
 *                  target (primary listing + aliases). All rows in
 *                  a group share the same `Group ID`; we coalesce.
 *   Group Type   → "Individual" | "Entity" | "Ship" → sdnType.
 *   Name 6       → primary name (entities) or surname (individuals).
 *                  OFSI splits a person's name across `Name 1..6`;
 *                  we concatenate the non-empty pieces.
 *   Name 1..5    → first / middle name pieces; combined with Name 6
 *                  they form the full legal name on individual rows.
 *   Alias Type   → presence indicates the row is an alias of the
 *                  primary listing in the same Group ID. Empty on
 *                  the primary row.
 *   Regime       → human-readable regime ("Russia", "Iran",
 *                  "Counter-Terrorism", …). Stored as the entry's
 *                  programs[]. (UK doesn't use a SDGT-style code
 *                  taxonomy — the regime name IS the program tag.)
 *   Country      → addressed-in country, when listed.
 *
 * If OFSI re-revs the CSV header names, the parser falls back to
 * a header-name lookup so column re-ordering doesn't break us.
 */
const OFSI_COLUMNS = {
  groupId: ["Group ID", "GroupID"],
  groupType: ["Group Type", "Type"],
  aliasType: ["Alias Type"],
  regime: ["Regime"],
  country: ["Country"],
  // Name pieces — OFSI splits names across up to six fields.
  name1: ["Name 1"],
  name2: ["Name 2"],
  name3: ["Name 3"],
  name4: ["Name 4"],
  name5: ["Name 5"],
  name6: ["Name 6"],
} as const;

interface OfsiRow {
  groupId: string;
  groupType: string;
  aliasType: string;
  regime: string;
  country: string;
  name: string;
  firstName?: string;
}

export function parseUkOfsiCsv(csv: string): UkOfsiEntry[] {
  const rows = readCsvRows(csv);
  if (rows.length === 0) return [];
  // OFSI usually prefixes the data with a one-line publication-date
  // banner before the actual header row. Skip leading rows until we
  // see one that contains "Group ID" (the canonical primary key).
  let headerIdx = 0;
  for (let i = 0; i < rows.length; i++) {
    if (rows[i]!.some((cell) => cell.trim() === "Group ID")) {
      headerIdx = i;
      break;
    }
  }
  const header = rows[headerIdx] ?? [];
  const indexes = resolveColumnIndexes(header);
  if (indexes.groupId < 0 || indexes.name6 < 0) return [];

  const dataRows: OfsiRow[] = [];
  for (let i = headerIdx + 1; i < rows.length; i++) {
    const r = rows[i]!;
    if (r.length === 0) continue;
    const groupId = (r[indexes.groupId] ?? "").trim();
    if (!groupId) continue;
    const namePieces: string[] = [];
    for (const idx of [
      indexes.name1,
      indexes.name2,
      indexes.name3,
      indexes.name4,
      indexes.name5,
    ]) {
      if (idx >= 0) {
        const piece = (r[idx] ?? "").trim();
        if (piece) namePieces.push(piece);
      }
    }
    const surname = (r[indexes.name6] ?? "").trim();
    const fullName = [...namePieces, surname].filter(Boolean).join(" ").trim();
    if (!fullName) continue;
    const firstName = namePieces.length > 0 ? namePieces.join(" ") : undefined;
    dataRows.push({
      groupId,
      groupType: (
        (indexes.groupType >= 0 ? r[indexes.groupType] : "") ?? ""
      ).trim(),
      aliasType: (
        (indexes.aliasType >= 0 ? r[indexes.aliasType] : "") ?? ""
      ).trim(),
      regime: ((indexes.regime >= 0 ? r[indexes.regime] : "") ?? "").trim(),
      country: ((indexes.country >= 0 ? r[indexes.country] : "") ?? "").trim(),
      name: surname || fullName,
      ...(firstName ? { firstName } : {}),
    });
  }

  // Group rows by Group ID — primary row + alias rows. The primary
  // is whichever row has an empty Alias Type; if none qualifies (rare),
  // pick the first row in the group.
  const grouped = new Map<string, OfsiRow[]>();
  for (const row of dataRows) {
    const list = grouped.get(row.groupId);
    if (list) list.push(row);
    else grouped.set(row.groupId, [row]);
  }

  const entries: UkOfsiEntry[] = [];
  for (const [groupId, group] of grouped) {
    const primary =
      group.find((r) => r.aliasType.trim() === "") ?? group[0]!;
    const sdnType = mapOfsiGroupType(primary.groupType);
    const aliases: string[] = [];
    const countries = new Set<string>();
    const regimes = new Set<string>();
    for (const r of group) {
      if (r !== primary && r.name) {
        const combined = [r.firstName, r.name].filter(Boolean).join(" ").trim();
        if (combined) aliases.push(combined);
      }
      if (r.country) countries.add(r.country);
      if (r.regime) regimes.add(r.regime);
    }
    entries.push({
      uid: groupId,
      ...(primary.firstName ? { firstName: primary.firstName } : {}),
      lastName: primary.name,
      sdnType,
      programs: [...regimes],
      aliases,
      addresses: [...countries],
      sourceList: "UK_OFSI",
    });
  }
  return entries;
}

function mapOfsiGroupType(raw: string): SdnEntry["sdnType"] {
  const value = raw.trim().toLowerCase();
  if (value === "individual") return "individual";
  if (value === "ship") return "vessel";
  if (value === "aircraft") return "aircraft";
  // Default to "entity" — covers "Entity" and any future codes
  // OFSI introduces.
  return "entity";
}

function resolveColumnIndexes(
  header: string[],
): {
  groupId: number;
  groupType: number;
  aliasType: number;
  regime: number;
  country: number;
  name1: number;
  name2: number;
  name3: number;
  name4: number;
  name5: number;
  name6: number;
} {
  const find = (candidates: readonly string[]): number => {
    for (let i = 0; i < header.length; i++) {
      const cell = header[i]!.trim();
      if (candidates.includes(cell)) return i;
    }
    return -1;
  };
  return {
    groupId: find(OFSI_COLUMNS.groupId),
    groupType: find(OFSI_COLUMNS.groupType),
    aliasType: find(OFSI_COLUMNS.aliasType),
    regime: find(OFSI_COLUMNS.regime),
    country: find(OFSI_COLUMNS.country),
    name1: find(OFSI_COLUMNS.name1),
    name2: find(OFSI_COLUMNS.name2),
    name3: find(OFSI_COLUMNS.name3),
    name4: find(OFSI_COLUMNS.name4),
    name5: find(OFSI_COLUMNS.name5),
    name6: find(OFSI_COLUMNS.name6),
  };
}

/**
 * RFC 4180-style CSV reader. Handles `,` separators, `"`-quoted
 * fields, `""` as an embedded quote, and CRLF / LF line endings.
 * Skips fully-blank lines so a trailing newline doesn't add an
 * empty trailing row.
 */
export function readCsvRows(csv: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  for (let i = 0; i < csv.length; i++) {
    const ch = csv[i]!;
    if (inQuotes) {
      if (ch === '"') {
        if (csv[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
      continue;
    }
    if (ch === '"') {
      inQuotes = true;
      continue;
    }
    if (ch === ",") {
      row.push(field);
      field = "";
      continue;
    }
    if (ch === "\n" || ch === "\r") {
      row.push(field);
      field = "";
      // Treat CRLF as a single newline.
      if (ch === "\r" && csv[i + 1] === "\n") i++;
      if (row.some((c) => c.length > 0)) rows.push(row);
      row = [];
      continue;
    }
    field += ch;
  }
  // Flush trailing field/row.
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    if (row.some((c) => c.length > 0)) rows.push(row);
  }
  return rows;
}

// ---------------------------------------------------------------------------
// Name normalization (mirrors ofac-sdn.ts so all adapters score identically)
// ---------------------------------------------------------------------------

function normalizeName(name: string): string {
  return name
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}
