/**
 * EU Consolidated Financial Sanctions adapter.
 *
 * The European Council publishes a consolidated XML feed of every
 * EU-adopted sanctions designation at:
 *
 *   https://webgate.ec.europa.eu/fsd/fsf/public/files/xmlFullSanctionsList_1_1
 *
 * Free, daily updates, no API key — same posture as the OFAC SDN
 * + CSL adapters (we own the list, control the cadence, no third
 * party in the critical path).
 *
 * Why a separate adapter from CSL: the EU schema has different
 * field semantics (nameAlias.strong=true|false marks confidence,
 * `subjectType.code = "P"|"E"` for Person/Enterprise, regulations
 * carry programme-type codes that don't map onto US program codes),
 * and EU operators legally only need EU-list screening — collapsing
 * EU into the CSL enum would muddy the audit trail and the
 * source-list chip taxonomy.
 *
 * Parser is hand-rolled regex (same posture as ofac-sdn.ts). The
 * EU schema is small and stable; a generic XML-parser dep would
 * pull a transitive surface for one consumer. If the EU re-revs
 * the schema (this is the 1.1 generation), swap to a real parser;
 * for the 2024-vintage feed this focused extractor is correct
 * and fast.
 */

import { jaroWinkler } from "./ofac-sdn.js";
import type { SdnEntry, SdnMatchType, SdnScreenResult } from "./ofac-sdn.js";

/**
 * Extension of `SdnEntry` carrying the EU-specific source tag so
 * downstream callers (agent, reviewer UI) can render which list
 * fired the hit. Programs[] is populated from the `programmeType`
 * codes on the entity's `<regulation>` blocks, e.g. `"AFG"`,
 * `"IRA"`, `"RUS"` — EU's own taxonomy, NOT the OFAC one.
 */
export interface EuSanctionsEntry extends SdnEntry {
  sourceList: "EU";
}

export interface EUConsolidatedAdapterOptions {
  /** In-memory cache TTL (ms). Defaults to 24h. */
  cacheTtlMs?: number;
  /** EU XML URL. Override for tests / air-gapped environments. */
  euXmlUrl?: string;
  /** Injectable fetch implementation — useful for tests. */
  fetchImpl?: typeof fetch;
}

const DEFAULT_EU_URL =
  "https://webgate.ec.europa.eu/fsd/fsf/public/files/xmlFullSanctionsList_1_1/content";
const DEFAULT_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

export class EUConsolidatedAdapter {
  private readonly cacheTtlMs: number;
  private readonly euXmlUrl: string;
  private readonly fetchImpl: typeof fetch;
  private cache: { entries: EuSanctionsEntry[]; fetchedAt: number } | null = null;

  constructor(options: EUConsolidatedAdapterOptions = {}) {
    this.cacheTtlMs = options.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS;
    this.euXmlUrl = options.euXmlUrl ?? DEFAULT_EU_URL;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async getEntries(): Promise<EuSanctionsEntry[]> {
    const now = Date.now();
    if (this.cache && now - this.cache.fetchedAt < this.cacheTtlMs) {
      return this.cache.entries;
    }
    const response = await this.fetchImpl(this.euXmlUrl);
    if (!response.ok) {
      throw new Error(
        `EU sanctions fetch failed: ${response.status} ${response.statusText}`,
      );
    }
    const xml = await response.text();
    const entries = parseEuSanctionsXml(xml);
    this.cache = { entries, fetchedAt: now };
    return entries;
  }

  /**
   * Same `screen()` semantics as OFACSdnAdapter / CSLAdapter: exact
   * normalized match → score 1.0, otherwise Jaro-Winkler against
   * legal name + every alias on the entry; the highest hit per entry
   * wins. Sorted by score desc.
   */
  screen(
    name: string,
    entries: EuSanctionsEntry[],
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
// EU XML parser
// ---------------------------------------------------------------------------

const ENTITY_RE = /<sanctionEntity\b([^>]*)>([\s\S]*?)<\/sanctionEntity>/g;

/**
 * Parse the EU consolidated XML into our internal entry shape.
 * Defensive: skips entities missing required fields (logicalId,
 * a usable name, a recognizable subjectType) rather than failing
 * the whole screen run on a single malformed record.
 *
 * Field mapping:
 *   logicalId       → uid
 *   subjectType.code "P"  → individual; "E" → entity (default)
 *   nameAlias[0]    → firstName + lastName (primary alias)
 *   nameAlias[1..n] → aliases[]
 *   regulation.programmeType → programs[]
 *   address.countryDescription → addresses[] (deduped)
 *   remark[0]       → remarks
 */
export function parseEuSanctionsXml(xml: string): EuSanctionsEntry[] {
  const entries: EuSanctionsEntry[] = [];
  for (const match of xml.matchAll(ENTITY_RE)) {
    const attrs = match[1] ?? "";
    const body = match[2] ?? "";
    const uid = extractAttr(attrs, "logicalId");
    if (!uid) continue;

    const subjectTypeCode = (
      extractAttr(getFirstSubElement(body, "subjectType") ?? "", "code") ?? "E"
    ).toUpperCase();
    const sdnType: SdnEntry["sdnType"] =
      subjectTypeCode === "P" ? "individual" : "entity";

    const nameAliases = collectNameAliases(body);
    const primary = nameAliases[0];
    if (
      !primary ||
      (!primary.lastName && !primary.firstName && !primary.wholeName)
    )
      continue;
    const firstName = primary.firstName ?? undefined;
    // EU `lastName` is sometimes empty for an entity (or for an alias
    // that only ships `wholeName`); fall back to the wholeName so
    // entity rows don't drop. We pack the full string into `lastName`
    // for that case to keep the SdnEntry shape consistent with OFAC.
    const lastName = primary.lastName ?? primary.wholeName ?? "";
    if (!lastName) continue;
    const aliases: string[] = [];
    for (let i = 1; i < nameAliases.length; i++) {
      const a = nameAliases[i]!;
      const combined =
        a.wholeName ??
        [a.firstName, a.lastName].filter(Boolean).join(" ").trim();
      if (combined) aliases.push(combined);
    }

    const programs = extractRegulationProgrammes(body);
    const addresses = extractEuAddresses(body);
    const remarks = extractFirstRemark(body);

    entries.push({
      uid,
      ...(firstName ? { firstName } : {}),
      lastName,
      sdnType,
      programs,
      aliases,
      addresses,
      ...(remarks ? { remarks } : {}),
      sourceList: "EU",
    });
  }
  return entries;
}

interface NameAliasRaw {
  firstName?: string | undefined;
  lastName?: string | undefined;
  wholeName?: string | undefined;
}

function collectNameAliases(body: string): NameAliasRaw[] {
  const out: NameAliasRaw[] = [];
  for (const m of body.matchAll(
    /<nameAlias\b([^>]*)\/>|<nameAlias\b([^>]*)>[\s\S]*?<\/nameAlias>/g,
  )) {
    const attrs = (m[1] ?? m[2] ?? "") as string;
    const firstName = extractAttr(attrs, "firstName");
    const lastName = extractAttr(attrs, "lastName");
    const wholeName = extractAttr(attrs, "wholeName");
    if (!firstName && !lastName && !wholeName) continue;
    const item: NameAliasRaw = {};
    if (firstName) item.firstName = firstName;
    if (lastName) item.lastName = lastName;
    if (wholeName) item.wholeName = wholeName;
    out.push(item);
  }
  return out;
}

function extractRegulationProgrammes(body: string): string[] {
  const programs = new Set<string>();
  for (const m of body.matchAll(
    /<regulation\b([^>]*)\/>|<regulation\b([^>]*)>[\s\S]*?<\/regulation>/g,
  )) {
    const attrs = (m[1] ?? m[2] ?? "") as string;
    const programme = extractAttr(attrs, "programmeType");
    if (programme) programs.add(programme);
  }
  return [...programs];
}

function extractEuAddresses(body: string): string[] {
  const countries = new Set<string>();
  for (const m of body.matchAll(
    /<address\b([^>]*)\/>|<address\b([^>]*)>[\s\S]*?<\/address>/g,
  )) {
    const attrs = (m[1] ?? m[2] ?? "") as string;
    const country = extractAttr(attrs, "countryDescription");
    if (country) countries.add(country);
  }
  return [...countries];
}

function extractFirstRemark(body: string): string | undefined {
  const m = body.match(/<remark\b[^>]*>([\s\S]*?)<\/remark>/);
  if (!m) return undefined;
  const text = decodeXmlEntities(m[1]!.trim());
  return text.length > 0 ? text : undefined;
}

function getFirstSubElement(body: string, tag: string): string | null {
  const m = body.match(
    new RegExp(`<${tag}\\b([^>]*)/>|<${tag}\\b([^>]*)>[\\s\\S]*?</${tag}>`),
  );
  if (!m) return null;
  return (m[1] ?? m[2] ?? "") as string;
}

function extractAttr(attrs: string, name: string): string | undefined {
  // Match name="..." or name='...'.
  const m = attrs.match(
    new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`),
  );
  if (!m) return undefined;
  const raw = (m[1] ?? m[2] ?? "") as string;
  const decoded = decodeXmlEntities(raw).trim();
  return decoded.length > 0 ? decoded : undefined;
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
