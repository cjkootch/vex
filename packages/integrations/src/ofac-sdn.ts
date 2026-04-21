/**
 * OFAC SDN screening adapter.
 *
 * The US Treasury publishes the Specially Designated Nationals list as a
 * free, publicly downloadable XML file at
 * https://www.treasury.gov/ofac/downloads/sdn.xml, updated daily. No API
 * key, no per-query cost — we download it ourselves, parse it, and screen
 * against it locally. That's the industry standard for serious compliance
 * shops: you own the list, you control the cadence, no third-party
 * dependency in the critical path.
 *
 * The parser is hand-rolled (not a generic XML library) because the OFAC
 * schema is small and stable — only six top-level fields matter — and the
 * alternative (`fast-xml-parser` et al) adds a transitive dependency for
 * a single consumer. If OFAC ever migrates to a CDATA-heavy or deeply
 * nested format, swap to a real parser; for the 2024-vintage SDN XML
 * this focused extractor is correct and fast.
 *
 * Fuzzy matching is Jaro-Winkler — the de-facto standard for
 * sanctions-screening name comparison — implemented inline to keep
 * external dependencies out of the compliance critical path.
 */

export interface SdnEntry {
  /** OFAC unique ID — stable across publications for the same listing. */
  uid: string;
  firstName?: string;
  /** For individuals: surname. For entities / vessels / aircraft: the name. */
  lastName: string;
  sdnType: "individual" | "entity" | "vessel" | "aircraft";
  /** Sanction programs (e.g. "CUBA", "IRAN", "SDGT"). */
  programs: string[];
  /** Aliases / AKAs pulled from <akaList>. */
  aliases: string[];
  /** Country names extracted from <addressList>. */
  addresses: string[];
  remarks?: string;
}

export type SdnMatchType = "exact" | "fuzzy" | "alias";

export interface SdnScreenResult {
  entry: SdnEntry;
  /** Which name on the entry triggered the match (legal name or an alias). */
  matchedName: string;
  /** 0..1 similarity score; 1.0 for an exact normalized match. */
  score: number;
  matchType: SdnMatchType;
}

export interface OFACSdnAdapterOptions {
  /** In-memory cache TTL (ms). Defaults to 24h. */
  cacheTtlMs?: number;
  /** SDN XML URL. Override for tests / air-gapped environments. */
  sdnXmlUrl?: string;
  /** Injectable fetch implementation — useful for tests. */
  fetchImpl?: typeof fetch;
}

const DEFAULT_SDN_URL = "https://www.treasury.gov/ofac/downloads/sdn.xml";
const DEFAULT_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

export class OFACSdnAdapter {
  private readonly cacheTtlMs: number;
  private readonly sdnXmlUrl: string;
  private readonly fetchImpl: typeof fetch;
  private cache: { entries: SdnEntry[]; fetchedAt: number } | null = null;

  constructor(options: OFACSdnAdapterOptions = {}) {
    this.cacheTtlMs = options.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS;
    this.sdnXmlUrl = options.sdnXmlUrl ?? DEFAULT_SDN_URL;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  /**
   * Download the current SDN XML (or return cache if fresh) and parse it
   * into a list of entries.
   */
  async getEntries(): Promise<SdnEntry[]> {
    const now = Date.now();
    if (this.cache && now - this.cache.fetchedAt < this.cacheTtlMs) {
      return this.cache.entries;
    }
    const response = await this.fetchImpl(this.sdnXmlUrl);
    if (!response.ok) {
      throw new Error(
        `OFAC SDN fetch failed: ${response.status} ${response.statusText}`,
      );
    }
    const xml = await response.text();
    const entries = parseSdnXml(xml);
    this.cache = { entries, fetchedAt: now };
    return entries;
  }

  /**
   * Screen a single name against the SDN list. Returns every match at or
   * above the threshold, sorted by score descending. Checks the entry's
   * legal name first, then every alias on the entry — alias matches are
   * tagged with matchType = "alias" so the UI can show which form of the
   * name triggered the hit.
   */
  screen(
    name: string,
    entries: SdnEntry[],
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
// Name normalization
// ---------------------------------------------------------------------------

/**
 * Lowercase, strip punctuation, collapse whitespace. Matches what the
 * screening literature calls "loose" normalization — good enough for a
 * first-pass gate; the Jaro-Winkler score fills in the rest.
 */
function normalizeName(name: string): string {
  return name
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "") // strip diacritics
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// ---------------------------------------------------------------------------
// Jaro-Winkler similarity (inline — no external fuzzy library)
// ---------------------------------------------------------------------------

/**
 * Jaro-Winkler similarity. Returns a value in [0, 1] where 1.0 is an
 * exact string match. Applies the Winkler prefix bonus (up to +0.1) when
 * the first four characters agree.
 *
 * Reference: William Winkler, "String Comparator Metrics and Enhanced
 * Decision Rules in the Fellegi-Sunter Model of Record Linkage" (1990).
 * Standard choice for name matching in sanctions workflows.
 */
export function jaroWinkler(a: string, b: string): number {
  if (a === b) return 1;
  if (a.length === 0 || b.length === 0) return 0;

  const matchDistance = Math.max(0, Math.floor(Math.max(a.length, b.length) / 2) - 1);
  const aMatches: boolean[] = new Array(a.length).fill(false);
  const bMatches: boolean[] = new Array(b.length).fill(false);
  let matches = 0;

  for (let i = 0; i < a.length; i++) {
    const start = Math.max(0, i - matchDistance);
    const end = Math.min(i + matchDistance + 1, b.length);
    for (let j = start; j < end; j++) {
      if (bMatches[j]) continue;
      if (a[i] !== b[j]) continue;
      aMatches[i] = true;
      bMatches[j] = true;
      matches++;
      break;
    }
  }
  if (matches === 0) return 0;

  let transpositions = 0;
  let k = 0;
  for (let i = 0; i < a.length; i++) {
    if (!aMatches[i]) continue;
    while (!bMatches[k]) k++;
    if (a[i] !== b[k]) transpositions++;
    k++;
  }
  transpositions /= 2;

  const m = matches;
  const jaro = (m / a.length + m / b.length + (m - transpositions) / m) / 3;

  // Winkler prefix bonus — up to first 4 characters, scaling factor 0.1.
  let prefix = 0;
  const prefixMax = Math.min(4, Math.min(a.length, b.length));
  for (let i = 0; i < prefixMax; i++) {
    if (a[i] === b[i]) prefix++;
    else break;
  }
  return jaro + prefix * 0.1 * (1 - jaro);
}

// ---------------------------------------------------------------------------
// SDN XML parser
// ---------------------------------------------------------------------------

const SDN_ENTRY_RE = /<sdnEntry\b[^>]*>([\s\S]*?)<\/sdnEntry>/g;
const UID_RE = /<uid>\s*([^<]+?)\s*<\/uid>/;
const FIRST_NAME_RE = /<firstName>\s*([^<]+?)\s*<\/firstName>/;
const LAST_NAME_RE = /<lastName>\s*([^<]+?)\s*<\/lastName>/;
const SDN_TYPE_RE = /<sdnType>\s*([^<]+?)\s*<\/sdnType>/;
const REMARKS_RE = /<remarks>\s*([^<]*)<\/remarks>/;

export function parseSdnXml(xml: string): SdnEntry[] {
  const entries: SdnEntry[] = [];
  for (const match of xml.matchAll(SDN_ENTRY_RE)) {
    const body = match[1] ?? "";
    const uid = body.match(UID_RE)?.[1];
    const lastName = body.match(LAST_NAME_RE)?.[1];
    const sdnTypeRaw = body.match(SDN_TYPE_RE)?.[1];
    if (!uid || !lastName || !sdnTypeRaw) continue;
    const sdnType = normalizeSdnType(sdnTypeRaw);
    if (!sdnType) continue;
    const firstNameRaw = body.match(FIRST_NAME_RE)?.[1];
    const remarksRaw = body.match(REMARKS_RE)?.[1];
    entries.push({
      uid: decodeXmlEntities(uid),
      ...(firstNameRaw
        ? { firstName: decodeXmlEntities(firstNameRaw) }
        : {}),
      lastName: decodeXmlEntities(lastName),
      sdnType,
      programs: extractPrograms(body),
      aliases: extractAliases(body),
      addresses: extractAddresses(body),
      ...(remarksRaw ? { remarks: decodeXmlEntities(remarksRaw) } : {}),
    });
  }
  return entries;
}

function normalizeSdnType(raw: string): SdnEntry["sdnType"] | null {
  const value = raw.trim().toLowerCase();
  if (value === "individual") return "individual";
  if (value === "entity") return "entity";
  if (value === "vessel") return "vessel";
  if (value === "aircraft") return "aircraft";
  return null;
}

function extractPrograms(body: string): string[] {
  const listMatch = body.match(
    /<programList>([\s\S]*?)<\/programList>/,
  );
  if (!listMatch) return [];
  const programs: string[] = [];
  for (const m of listMatch[1]!.matchAll(
    /<program>\s*([^<]+?)\s*<\/program>/g,
  )) {
    programs.push(decodeXmlEntities(m[1]!));
  }
  return programs;
}

function extractAliases(body: string): string[] {
  const listMatch = body.match(/<akaList>([\s\S]*?)<\/akaList>/);
  if (!listMatch) return [];
  const aliases: string[] = [];
  for (const akaMatch of listMatch[1]!.matchAll(
    /<aka\b[^>]*>([\s\S]*?)<\/aka>/g,
  )) {
    const akaBody = akaMatch[1]!;
    const firstName = akaBody.match(FIRST_NAME_RE)?.[1];
    const lastName = akaBody.match(LAST_NAME_RE)?.[1];
    if (!lastName) continue;
    const combined = [firstName, lastName]
      .filter(Boolean)
      .map((s) => decodeXmlEntities(s as string))
      .join(" ")
      .trim();
    if (combined) aliases.push(combined);
  }
  return aliases;
}

function extractAddresses(body: string): string[] {
  const listMatch = body.match(
    /<addressList>([\s\S]*?)<\/addressList>/,
  );
  if (!listMatch) return [];
  const countries = new Set<string>();
  for (const addrMatch of listMatch[1]!.matchAll(
    /<address\b[^>]*>([\s\S]*?)<\/address>/g,
  )) {
    const country = addrMatch[1]!.match(/<country>\s*([^<]+?)\s*<\/country>/)?.[1];
    if (country) countries.add(decodeXmlEntities(country));
  }
  return [...countries];
}

function decodeXmlEntities(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, n) =>
      String.fromCodePoint(Number.parseInt(n, 16)),
    );
}
