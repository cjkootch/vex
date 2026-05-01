/**
 * Thin HTTP client over procur's `/intelligence/*` REST surface. Wraps
 * the assistant tools that procur exposes (analyze_supplier,
 * find_buyers_for_offer, evaluate_offer_against_history, etc.) so vex
 * agents can pull procur-side intelligence into the deal lifecycle
 * without coupling at the database layer.
 *
 * Boundary commitments (per docs/procur-integration.md):
 *   - One-way data flow. Procur is read-only from vex. Vex's private
 *     behavioural data never crosses the wire.
 *   - Service-to-service auth via long-lived bearer token. The token
 *     lives in `PROCUR_API_TOKEN` env; the base URL in
 *     `PROCUR_API_BASE_URL` (e.g. `https://procur.example.com/api`).
 *   - Fail-soft on procur unavailability. Network errors / 5xx /
 *     timeouts return a typed `{ ok: false, reason }` so callers can
 *     degrade gracefully (e.g. ResearchAgent still produces a brief
 *     from internal touchpoints when procur is down).
 *   - 10s per-request timeout by default — procur's materialised views
 *     are pre-computed so <200ms is normal; anything past 10s is a
 *     real outage.
 *
 * Caching is OUT of scope here. The 7-day snapshot cache lives in vex
 * via `procur_intelligence_snapshots`; see the brief §5.2.
 */

export interface ProcurClientConfig {
  /** Base URL — `${baseUrl}/intelligence/...` is what each call hits. */
  baseUrl: string | null;
  /** Bearer token issued by procur. Null disables every call (no-op). */
  apiToken: string | null;
  /** Override for tests. */
  fetchImpl?: typeof fetch;
  /** Override for tests. */
  log?: (level: "info" | "warn" | "error", msg: string, meta?: unknown) => void;
  /** Per-request timeout. Default 10_000ms. */
  timeoutMs?: number;
}

/**
 * Discriminated-union result type. Every method returns either
 * `{ ok: true, data }` or `{ ok: false, reason, ... }` — no thrown
 * errors on transport / auth / 5xx, so callers don't need try/catch
 * for the fail-soft path. Programming errors (bad arg shape) still
 * throw, since those are bugs.
 */
export type ProcurResult<T> =
  | { ok: true; data: T }
  | {
      ok: false;
      reason:
        | "disabled"
        | "timeout"
        | "http_error"
        | "exception"
        | "not_found";
      status?: number;
      message?: string;
    };

// ---------------------------------------------------------------------------
// Response shapes — narrow slices that match procur's assistant-tool output.
// Every field is optional on the wire side; we normalise at the boundary so
// downstream agents have a stable type contract.
// ---------------------------------------------------------------------------

export interface SupplierProfile {
  kind: "profile";
  supplierId: string;
  legalName: string;
  country: string | null;
  role: string | null;
  categories: string[];
  awardCount: number;
  awardTotalUsd: number | null;
  recentAwardCount: number;
  /** Days since the most-recent award. Null if no awards on record. */
  daysSinceLastAward: number | null;
  /** Procur tags surfaced for this supplier (e.g. `high_award_velocity`). */
  tags: string[];
  distressSignals: Array<{
    kind: string;
    detail: string;
    observedAt: string;
  }>;
  notes: string | null;
}

export interface SupplierDisambiguation {
  kind: "disambiguation_needed";
  candidates: Array<{
    supplierId: string;
    legalName: string;
    country: string | null;
    awardCount: number;
  }>;
}

export interface SupplierNotFound {
  kind: "not_found";
  searched: string;
}

export type SupplierAnalysisResult =
  | SupplierProfile
  | SupplierDisambiguation
  | SupplierNotFound;

export interface SupplierPricingAnalysisResult {
  supplierId: string;
  /** Average delta vs. category benchmark, expressed as a percentage. */
  avgDeltaPct: number | null;
  medianDeltaPct: number | null;
  stddevDeltaPct: number | null;
  sampleSize: number;
  byCategory: Array<{
    categoryTag: string;
    avgDeltaPct: number;
    sampleSize: number;
  }>;
}

export interface RecentCargoesResult {
  cargoes: Array<{
    cargoId: string;
    supplierName: string;
    buyerCountry: string;
    commodity: string;
    quantityMt: number | null;
    arrivedAt: string | null;
    vesselName: string | null;
    confidence: "weak" | "medium" | "strong";
  }>;
  totalCount: number;
}

export interface OfferEvaluationResult {
  benchmarkCode: string;
  benchmarkSpotUsd: number | null;
  effectiveBenchmarkUsd: number | null;
  offerDeltaUsd: number | null;
  offerDeltaPct: number | null;
  historicalMeanDeltaPct: number | null;
  historicalMedianDeltaPct: number | null;
  historicalStddevDeltaPct: number | null;
  historicalSampleSize: number;
  zScore: number | null;
  percentile: number | null;
  /**
   * `aggressive` — well below typical premium (possible distress sale).
   * `competitive` — slightly below typical.
   * `fair`        — within ±0.5σ of typical.
   * `high`        — above typical but inside one σ.
   * `outlier_high`— >1σ above typical; flag for review.
   */
  verdict: "aggressive" | "competitive" | "fair" | "high" | "outlier_high";
  rationale: string | null;
}

export interface FindBuyersResult {
  candidates: Array<{
    buyerEntityId: string;
    legalName: string;
    country: string;
    awardCount: number;
    awardTotalUsd: number | null;
    avgAwardSizeUsd: number | null;
    lastAwardAt: string | null;
    /** procur's view of how relevant this buyer is to the offer (0-1). */
    relevanceScore: number;
    rationale: string;
  }>;
  totalCount: number;
}

export interface FindSuppliersForTenderResult {
  candidates: Array<{
    supplierEntityId: string;
    legalName: string;
    country: string;
    pastTenderWins: number;
    avgWinSizeUsd: number | null;
    relevanceScore: number;
    rationale: string;
  }>;
  totalCount: number;
}

export interface FindDistressedSuppliersResult {
  suppliers: Array<{
    supplierEntityId: string;
    legalName: string;
    country: string;
    distressSignal: {
      kind: string;
      detail: string;
      observedAt: string;
    };
    awardVelocityChangePct: number | null;
  }>;
  totalCount: number;
}

export interface BuyerPricingAnalysisResult {
  buyerEntityId: string;
  avgDeltaPct: number | null;
  medianDeltaPct: number | null;
  stddevDeltaPct: number | null;
  sampleSize: number;
  byCategory: Array<{
    categoryTag: string;
    avgDeltaPct: number;
    sampleSize: number;
  }>;
}

export interface EntityNewsEvent {
  id: string;
  entitySlug: string;
  publishedAt: string;
  source: string;
  url: string | null;
  headline: string;
  summary: string | null;
  sentiment: "positive" | "neutral" | "negative" | null;
  tags: string[];
}

// ---------------------------------------------------------------------------
// Client implementation.
// ---------------------------------------------------------------------------

export interface ProcurClient {
  /** Whether the client has both base URL + token configured. */
  isEnabled(): boolean;

  analyzeSupplier(args: {
    supplierId?: string;
    supplierName?: string;
    yearsLookback?: number;
  }): Promise<ProcurResult<SupplierAnalysisResult>>;

  analyzeSupplierPricing(args: {
    supplierId?: string;
    supplierName?: string;
    minConfidence?: number;
    yearsLookback?: number;
    categoryFilter?: string;
  }): Promise<ProcurResult<SupplierPricingAnalysisResult>>;

  findRecentCargoes(args: {
    destinationCountry?: string;
    destinationEntitySlug?: string;
    originCountry?: string;
    vesselCategory?: string;
    daysLookback?: number;
    minConfidence?: number;
  }): Promise<ProcurResult<RecentCargoesResult>>;

  evaluateOffer(args: {
    categoryTag: string;
    grade?: string;
    buyerCountry: string;
    offeredPriceUsd: number;
    offeredPriceUnit: string;
    evaluationDate?: string;
  }): Promise<ProcurResult<OfferEvaluationResult>>;

  findBuyersForOffer(args: {
    categoryTag: string;
    descriptionKeywords?: string[];
    buyerCountries?: string[];
    yearsLookback?: number;
    minAwards?: number;
    limit?: number;
  }): Promise<ProcurResult<FindBuyersResult>>;

  findSuppliersForTender(args: {
    procurOpportunityId: string;
    originBias?: { lat: number; lon: number; weightFactor?: number };
    limit?: number;
  }): Promise<ProcurResult<FindSuppliersForTenderResult>>;

  findDistressedSuppliers(args: {
    categoryTag?: string;
    countries?: string[];
    minPrevAwards?: number;
    velocityChangeMax?: number;
  }): Promise<ProcurResult<FindDistressedSuppliersResult>>;

  analyzeBuyerPricing(args: {
    buyerEntityId?: string;
    buyerName?: string;
    minConfidence?: number;
    yearsLookback?: number;
  }): Promise<ProcurResult<BuyerPricingAnalysisResult>>;

  getEntityNews(args: {
    entitySlug: string;
    daysLookback?: number;
  }): Promise<ProcurResult<{ events: EntityNewsEvent[] }>>;

  /**
   * Push a vex-enriched contact back to procur. Slice 1.5 — closes the
   * loop on per-contact web research: when vex's ContactEnrichmentAgent
   * finds a confident email/title/phone for a contact at a procur-
   * sourced organisation, we share the discovery so procur's entity
   * graph stays current.
   *
   * Procur is expected to:
   *   - Treat the push as a SUGGESTION, not a source-of-truth overwrite.
   *     Procur's existing data (if any) wins; vex's lands as
   *     `source: "vex"` for human review.
   *   - Stamp the contact with a sourceUrl + confidence per field so
   *     operators can audit / promote suggestions.
   *   - Return 200 on accepted, 4xx if the entity isn't recognised.
   *
   * Vex side: only fires when (a) the org has `external_keys.procur`
   * set, (b) at least one field landed on the contact with confidence
   * ≥ 0.6, (c) procur is enabled.
   */
  shareContactEnrichment(args: {
    entitySlug: string;
    name: string;
    fields: ContactEnrichmentFields;
  }): Promise<ProcurResult<ContactEnrichmentShareResult>>;

  /**
   * Push a vex sanctions-screening verdict back to procur. Closes the
   * loop on per-org compliance: when vex's OFACScreeningAgent runs
   * against a procur-sourced organisation, we share the verdict so
   * procur's compliance graph stays current and other tenants benefit
   * from the cross-list coverage we ship.
   *
   * Each call records ONE discrete screen event. Procur appends one
   * row per (vex_tenant_id, screen_id); the unique index dedupes 5xx
   * retries. Multi-tenant displays surface the union per (source_list)
   * so reviewers see cross-tenant disagreement when it exists.
   *
   * Privacy posture (intentionally narrow):
   *
   *   SHARED on every screen of a procur org:
   *     - vexTenantId: stable opaque id for this vex workspace.
   *       Procur stores it as text and never derefs into our user
   *       model — lets them attribute a screen to "vex tenant A"
   *       without learning anything else about the tenant.
   *     - screenId: UUIDv4 generated vex-side per-screen. Procur
   *       dedupes on (vex_tenant_id, screen_id) so retries are safe.
   *     - status: "clear" | "potential_match" | "confirmed_match"
   *     - sources_checked: which lists ran (e.g. ["us_csl", "eu",
   *       "uk_ofsi"]). Lets procur surface "vex screened against the
   *       EU list 2h ago" as freshness signal.
   *     - matches[] (empty for clear): per-hit { source_list, sdn_uid,
   *       programs, confidence_band }. All public-list metadata —
   *       no operator decisions, no raw scores, no matched-name
   *       strings (could leak our normalisation / aliases).
   *     - confidence_band: "high_confidence" (≥0.95) | "fuzzy_review"
   *       (0.85–0.95). Banded so procur's reviewers don't anchor on
   *       vex's specific Jaro-Winkler output.
   *
   *   NOT SHARED:
   *     - cleared_by_operator status — that's a tenant-specific
   *       judgement; procur's own reviewers make their own call on
   *       the underlying objective match.
   *     - The reviewer who cleared, or the reason they wrote.
   *     - Raw similarity scores.
   *     - Matched name strings or alias permutations.
   *     - Sub-threshold (<0.85) probable-cause hits — already
   *       filtered out by the agent.
   *
   * Procur is expected to:
   *   - Store the row append-only, keyed on (vex_tenant_id, screen_id).
   *   - Surface latest-wins per (source_list) on /entities/{slug}, with
   *     full per-tenant breakdown available on demand.
   *   - Stamp `source: "vex"` so operators can audit / promote
   *     suggestions.
   *   - Return 200 on accepted, 4xx if the entity isn't recognised.
   *
   * Vex side: only fires when (a) the org has `external_keys.procur`
   * set, (b) procur is enabled, (c) the screen produced a verdict
   * other than `cleared_by_operator` (skipped per posture above).
   */
  shareOrgSanctionsScreen(args: {
    /** Procur's own slug for the entity. */
    entitySlug: string;
    /** Stable opaque id for the vex workspace running this screen. */
    vexTenantId: string;
    /** UUIDv4 generated per-screen, vex-side. Procur dedupes on (vexTenantId, screenId). */
    screenId: string;
    legalName: string;
    status: "clear" | "potential_match" | "confirmed_match";
    sourcesChecked: string[];
    matches: SanctionsShareMatch[];
    screenedAt: string;
  }): Promise<ProcurResult<SanctionsShareResult>>;
}

export interface ContactEnrichmentField {
  value: string;
  confidence: number;
  sourceUrl: string | null;
}

export interface ContactEnrichmentFields {
  email?: ContactEnrichmentField;
  title?: ContactEnrichmentField;
  phone?: ContactEnrichmentField;
  linkedinUrl?: ContactEnrichmentField;
}

export interface ContactEnrichmentShareResult {
  contactId: string;
  status: "created" | "updated" | "noop";
}

/**
 * One match row in a sanctions-screening share. Public-list metadata
 * only — see `shareOrgSanctionsStatus` docstring for the privacy
 * posture (no raw scores, no matched-name strings, no operator
 * decisions).
 */
export interface SanctionsShareMatch {
  /**
   * Which list the entry came from. Mirrors `OfacMatchRecord.sourceList`
   * — `SDN`, `EL`, `DPL`, `UVL`, `MEU`, `DTC`, `ISN`, `CAP`, `NS-PLC`,
   * `SSI`, `FSE` (US CSL), `EU`, `UK_OFSI`, or `OTHER`.
   */
  sourceList: string;
  /** Public unique id of the listing (OFAC SDN UID, EU logicalId, OFSI Group ID, …). */
  sdnUid: string;
  /** Sanction programmes the listing carries (public). */
  programs: string[];
  /** Banded so procur reviewers don't anchor on vex's raw similarity score. */
  confidenceBand: "high_confidence" | "fuzzy_review";
  /** individual | entity | vessel | aircraft. */
  sdnType: string;
}

export interface SanctionsShareResult {
  /**
   * Echoes the `screenId` we sent (UUIDv4). Procur stores it on its
   * `entity_sanctions_screens` row as the dedupe key alongside
   * `vex_tenant_id`; the response confirms the row landed.
   */
  screenId: string;
  status: "created" | "updated" | "noop";
}

export function createProcurClient(config: ProcurClientConfig): ProcurClient {
  const fetchImpl = config.fetchImpl ?? fetch;
  const log =
    config.log ??
    ((level, msg, meta) => {
      const out = level === "error" ? console.error : console.warn;
      // eslint-disable-next-line no-console
      out(JSON.stringify({ level, msg, meta, service: "procur" }));
    });
  const timeoutMs = config.timeoutMs ?? 10_000;

  const enabled = (): boolean =>
    Boolean(
      config.baseUrl &&
        config.apiToken &&
        config.baseUrl.length > 0 &&
        config.apiToken.length > 0,
    );

  async function call<T>(
    method: "GET" | "POST",
    path: string,
    body?: Record<string, unknown> | undefined,
  ): Promise<ProcurResult<T>> {
    if (!enabled()) {
      return { ok: false, reason: "disabled" };
    }
    const url = `${config.baseUrl!.replace(/\/$/, "")}${path}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImpl(url, {
        method,
        headers: {
          authorization: `Bearer ${config.apiToken}`,
          ...(body ? { "content-type": "application/json" } : {}),
        },
        signal: controller.signal,
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      if (response.status === 404) {
        return { ok: false, reason: "not_found", status: 404 };
      }
      if (!response.ok) {
        const text = await response.text().catch(() => "");
        log("warn", "procur non-2xx", {
          status: response.status,
          path,
          text: text.slice(0, 200),
        });
        return {
          ok: false,
          reason: "http_error",
          status: response.status,
          message: text.slice(0, 200),
        };
      }
      const data = (await response.json()) as T;
      return { ok: true, data };
    } catch (err) {
      const name = (err as Error).name;
      const reason = name === "AbortError" ? "timeout" : "exception";
      log("warn", `procur ${reason}`, {
        error: (err as Error).message,
        path,
      });
      return {
        ok: false,
        reason,
        message: (err as Error).message,
      };
    } finally {
      clearTimeout(timer);
    }
  }

  function qs(params: Record<string, unknown>): string {
    const search = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) {
      if (value === undefined || value === null) continue;
      if (Array.isArray(value)) {
        if (value.length === 0) continue;
        search.set(key, value.join(","));
      } else {
        search.set(key, String(value));
      }
    }
    const out = search.toString();
    return out ? `?${out}` : "";
  }

  return {
    isEnabled: enabled,

    async analyzeSupplier(args) {
      const idOrName = args.supplierId ?? args.supplierName;
      if (!idOrName) {
        throw new Error(
          "procur.analyzeSupplier: supplierId or supplierName required",
        );
      }
      const path = `/intelligence/supplier/${encodeURIComponent(idOrName)}${qs({
        years_lookback: args.yearsLookback,
      })}`;
      return call<SupplierAnalysisResult>("GET", path);
    },

    async analyzeSupplierPricing(args) {
      const idOrName = args.supplierId ?? args.supplierName;
      if (!idOrName) {
        throw new Error(
          "procur.analyzeSupplierPricing: supplierId or supplierName required",
        );
      }
      const path = `/intelligence/supplier/${encodeURIComponent(idOrName)}/pricing${qs(
        {
          min_confidence: args.minConfidence,
          years_lookback: args.yearsLookback,
          category_filter: args.categoryFilter,
        },
      )}`;
      return call<SupplierPricingAnalysisResult>("GET", path);
    },

    async findRecentCargoes(args) {
      const path = `/intelligence/cargoes${qs({
        destination_country: args.destinationCountry,
        destination_entity_slug: args.destinationEntitySlug,
        origin_country: args.originCountry,
        vessel_category: args.vesselCategory,
        days_lookback: args.daysLookback,
        min_confidence: args.minConfidence,
      })}`;
      return call<RecentCargoesResult>("GET", path);
    },

    async evaluateOffer(args) {
      return call<OfferEvaluationResult>(
        "POST",
        "/intelligence/evaluate-offer",
        {
          category_tag: args.categoryTag,
          grade: args.grade,
          buyer_country: args.buyerCountry,
          offered_price_usd: args.offeredPriceUsd,
          offered_price_unit: args.offeredPriceUnit,
          evaluation_date: args.evaluationDate,
        },
      );
    },

    async findBuyersForOffer(args) {
      return call<FindBuyersResult>("POST", "/intelligence/find-buyers", {
        category_tag: args.categoryTag,
        description_keywords: args.descriptionKeywords,
        buyer_countries: args.buyerCountries,
        years_lookback: args.yearsLookback,
        min_awards: args.minAwards,
        limit: args.limit,
      });
    },

    async findSuppliersForTender(args) {
      return call<FindSuppliersForTenderResult>(
        "POST",
        "/intelligence/find-suppliers-for-tender",
        {
          procur_opportunity_id: args.procurOpportunityId,
          origin_bias: args.originBias,
          limit: args.limit,
        },
      );
    },

    async findDistressedSuppliers(args) {
      const path = `/intelligence/distressed-suppliers${qs({
        category_tag: args.categoryTag,
        countries: args.countries,
        min_prev_awards: args.minPrevAwards,
        velocity_change_max: args.velocityChangeMax,
      })}`;
      return call<FindDistressedSuppliersResult>("GET", path);
    },

    async analyzeBuyerPricing(args) {
      const path = `/intelligence/buyer-pricing${qs({
        buyer_entity_id: args.buyerEntityId,
        buyer_name: args.buyerName,
        min_confidence: args.minConfidence,
        years_lookback: args.yearsLookback,
      })}`;
      return call<BuyerPricingAnalysisResult>("GET", path);
    },

    async getEntityNews(args) {
      const path = `/intelligence/entity-news/${encodeURIComponent(args.entitySlug)}${qs(
        {
          days_lookback: args.daysLookback,
        },
      )}`;
      return call<{ events: EntityNewsEvent[] }>("GET", path);
    },

    async shareContactEnrichment(args) {
      const path = `/intelligence/entity/${encodeURIComponent(args.entitySlug)}/contact-enrichment`;
      return call<ContactEnrichmentShareResult>("POST", path, {
        name: args.name,
        fields: serializeFields(args.fields),
        source: "vex",
        enriched_at: new Date().toISOString(),
      });
    },

    async shareOrgSanctionsScreen(args) {
      const path = `/intelligence/entity/${encodeURIComponent(args.entitySlug)}/sanctions-screen`;
      return call<SanctionsShareResult>("POST", path, {
        vex_tenant_id: args.vexTenantId,
        screen_id: args.screenId,
        legal_name: args.legalName,
        status: args.status,
        sources_checked: args.sourcesChecked,
        matches: args.matches.map((m) => ({
          source_list: m.sourceList,
          sdn_uid: m.sdnUid,
          programs: m.programs,
          confidence_band: m.confidenceBand,
          sdn_type: m.sdnType,
        })),
        screened_at: args.screenedAt,
        source: "vex",
      });
    },
  };
}

function serializeFields(fields: ContactEnrichmentFields): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(fields)) {
    if (!v) continue;
    out[k] = {
      value: v.value,
      confidence: v.confidence,
      source_url: v.sourceUrl,
    };
  }
  return out;
}

/**
 * Hash-friendly string key for cache lookups in the snapshot table.
 * Sorts keys so semantically-equal arg objects produce identical keys.
 */
export function buildProcurQueryHash(
  tool: string,
  args: Record<string, unknown>,
): string {
  const sorted: Record<string, unknown> = {};
  for (const k of Object.keys(args).sort()) {
    const v = args[k];
    if (v === undefined || v === null) continue;
    sorted[k] = Array.isArray(v) ? [...v].sort() : v;
  }
  return `${tool}:${JSON.stringify(sorted)}`;
}
