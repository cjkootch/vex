import { describe, expect, it, vi } from "vitest";
import {
  buildProcurQueryHash,
  createProcurClient,
  type SupplierProfile,
} from "./procur.js";

const BASE_CONFIG = {
  baseUrl: "https://procur.example.com/api",
  apiToken: "test-token",
};

function silentLog(): (
  level: "info" | "warn" | "error",
  msg: string,
  meta?: unknown,
) => void {
  return () => {
    return;
  };
}

function makeFetch(
  status: number,
  body: unknown,
): typeof fetch {
  return vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    text: async () => (typeof body === "string" ? body : JSON.stringify(body)),
    json: async () => body,
  }) as unknown as typeof fetch;
}

describe("createProcurClient", () => {
  it("isEnabled returns false when baseUrl is missing", () => {
    const c = createProcurClient({
      baseUrl: null,
      apiToken: "x",
      log: silentLog(),
    });
    expect(c.isEnabled()).toBe(false);
  });

  it("isEnabled returns false when apiToken is missing", () => {
    const c = createProcurClient({
      baseUrl: "https://procur.example.com/api",
      apiToken: null,
      log: silentLog(),
    });
    expect(c.isEnabled()).toBe(false);
  });

  it("returns disabled without making a network call when not configured", async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    const c = createProcurClient({
      baseUrl: null,
      apiToken: null,
      fetchImpl,
      log: silentLog(),
    });
    const r = await c.analyzeSupplier({ supplierName: "Acme" });
    expect(r).toEqual({ ok: false, reason: "disabled" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("attaches a Bearer Authorization header to every call", async () => {
    const fetchImpl = makeFetch(200, {
      kind: "profile",
      supplierId: "s-1",
      legalName: "Acme",
      country: "US",
      role: "trader",
      categories: [],
      awardCount: 0,
      awardTotalUsd: null,
      recentAwardCount: 0,
      daysSinceLastAward: null,
      tags: [],
      distressSignals: [],
      notes: null,
    });
    const c = createProcurClient({
      ...BASE_CONFIG,
      fetchImpl,
      log: silentLog(),
    });
    await c.analyzeSupplier({ supplierName: "Acme" });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [, init] = (fetchImpl as unknown as { mock: { calls: [string, RequestInit][] } }).mock.calls[0]!;
    expect((init.headers as Record<string, string>).authorization).toBe(
      "Bearer test-token",
    );
  });

  it("encodes query params and skips null/undefined values", async () => {
    const fetchImpl = makeFetch(200, { events: [] });
    const c = createProcurClient({
      ...BASE_CONFIG,
      fetchImpl,
      log: silentLog(),
    });
    await c.getEntityNews({
      entitySlug: "acme corp",
      daysLookback: 30,
    });
    const [url] = (fetchImpl as unknown as { mock: { calls: [string][] } }).mock.calls[0]!;
    expect(url).toContain("/intelligence/entity-news/acme%20corp");
    expect(url).toContain("days_lookback=30");
  });

  it("joins arrays as comma-separated strings in query params", async () => {
    const fetchImpl = makeFetch(200, { suppliers: [], totalCount: 0 });
    const c = createProcurClient({
      ...BASE_CONFIG,
      fetchImpl,
      log: silentLog(),
    });
    await c.findDistressedSuppliers({
      countries: ["US", "DO", "JM"],
      minPrevAwards: 5,
    });
    const [url] = (fetchImpl as unknown as { mock: { calls: [string][] } }).mock.calls[0]!;
    expect(url).toContain("countries=US%2CDO%2CJM");
    expect(url).toContain("min_prev_awards=5");
  });

  it("snake-cases POST body keys for evaluateOffer", async () => {
    const fetchImpl = makeFetch(200, {
      benchmarkCode: "nyh_ulsd",
      verdict: "fair",
    });
    const c = createProcurClient({
      ...BASE_CONFIG,
      fetchImpl,
      log: silentLog(),
    });
    await c.evaluateOffer({
      categoryTag: "diesel",
      grade: "ULSD",
      buyerCountry: "DO",
      offeredPriceUsd: 0.85,
      offeredPriceUnit: "USD/L",
      evaluationDate: "2026-04-28",
    });
    const [url, init] = (fetchImpl as unknown as { mock: { calls: [string, RequestInit][] } })
      .mock.calls[0]!;
    expect(url).toBe("https://procur.example.com/api/intelligence/evaluate-offer");
    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(body).toMatchObject({
      category_tag: "diesel",
      buyer_country: "DO",
      offered_price_usd: 0.85,
      offered_price_unit: "USD/L",
    });
  });

  it("returns ok=true with the parsed payload on 2xx", async () => {
    const profile: SupplierProfile = {
      kind: "profile",
      supplierId: "s-1",
      legalName: "Refidomsa",
      country: "DO",
      role: "refiner",
      categories: ["diesel"],
      awardCount: 14,
      awardTotalUsd: 22_000_000,
      recentAwardCount: 4,
      daysSinceLastAward: 12,
      tags: ["caribbean-refiner"],
      distressSignals: [],
      notes: null,
    };
    const fetchImpl = makeFetch(200, profile);
    const c = createProcurClient({
      ...BASE_CONFIG,
      fetchImpl,
      log: silentLog(),
    });
    const r = await c.analyzeSupplier({ supplierName: "Refidomsa" });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.data).toEqual(profile);
  });

  it("returns reason=not_found on 404", async () => {
    const fetchImpl = makeFetch(404, "");
    const c = createProcurClient({
      ...BASE_CONFIG,
      fetchImpl,
      log: silentLog(),
    });
    const r = await c.analyzeSupplier({ supplierName: "Nope" });
    expect(r).toMatchObject({ ok: false, reason: "not_found", status: 404 });
  });

  it("returns reason=http_error with status on 5xx", async () => {
    const fetchImpl = makeFetch(503, "service unavailable");
    const c = createProcurClient({
      ...BASE_CONFIG,
      fetchImpl,
      log: silentLog(),
    });
    const r = await c.analyzeSupplier({ supplierName: "Acme" });
    expect(r).toMatchObject({ ok: false, reason: "http_error", status: 503 });
  });

  it("returns reason=exception when fetch throws", async () => {
    const fetchImpl = vi
      .fn()
      .mockRejectedValue(new Error("ENOTFOUND")) as unknown as typeof fetch;
    const c = createProcurClient({
      ...BASE_CONFIG,
      fetchImpl,
      log: silentLog(),
    });
    const r = await c.analyzeSupplier({ supplierName: "Acme" });
    expect(r).toMatchObject({ ok: false, reason: "exception" });
  });

  it("returns reason=timeout when the abort signal fires", async () => {
    const abortError = Object.assign(new Error("aborted"), {
      name: "AbortError",
    });
    const fetchImpl = vi
      .fn()
      .mockRejectedValue(abortError) as unknown as typeof fetch;
    const c = createProcurClient({
      ...BASE_CONFIG,
      fetchImpl,
      log: silentLog(),
      timeoutMs: 50,
    });
    const r = await c.analyzeSupplier({ supplierName: "Acme" });
    expect(r).toMatchObject({ ok: false, reason: "timeout" });
  });

  it("throws on missing required identifier (programmer error, not a fail-soft)", async () => {
    const c = createProcurClient({
      ...BASE_CONFIG,
      fetchImpl: vi.fn() as unknown as typeof fetch,
      log: silentLog(),
    });
    await expect(c.analyzeSupplier({})).rejects.toThrow(
      /supplierId or supplierName required/,
    );
  });

  it("shareOrgSanctionsScreen posts a snake-cased payload to the sanctions-screen path", async () => {
    const fetchImpl = makeFetch(200, {
      screenId: "11111111-1111-4111-8111-111111111111",
      status: "created",
    });
    const c = createProcurClient({
      ...BASE_CONFIG,
      fetchImpl,
      log: silentLog(),
    });
    const result = await c.shareOrgSanctionsScreen({
      entitySlug: "armasuisse",
      vexTenantId: "01HSEEDWRK0000000000000001",
      screenId: "11111111-1111-4111-8111-111111111111",
      legalName: "Armasuisse",
      status: "potential_match",
      sourcesChecked: ["us_csl", "eu"],
      matches: [
        {
          sourceList: "EU",
          sdnUid: "EU-RU-1234",
          programs: ["RUS"],
          confidenceBand: "high_confidence",
          sdnType: "entity",
        },
      ],
      screenedAt: "2026-05-01T03:00:00.000Z",
    });
    expect(result.ok).toBe(true);

    const [url, init] = (fetchImpl as unknown as {
      mock: { calls: [string, RequestInit][] };
    }).mock.calls[0]!;
    expect(url).toBe(
      "https://procur.example.com/api/intelligence/entity/armasuisse/sanctions-screen",
    );
    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(body).toMatchObject({
      vex_tenant_id: "01HSEEDWRK0000000000000001",
      screen_id: "11111111-1111-4111-8111-111111111111",
      legal_name: "Armasuisse",
      status: "potential_match",
      sources_checked: ["us_csl", "eu"],
      screened_at: "2026-05-01T03:00:00.000Z",
      source: "vex",
      matches: [
        {
          source_list: "EU",
          sdn_uid: "EU-RU-1234",
          programs: ["RUS"],
          confidence_band: "high_confidence",
          sdn_type: "entity",
        },
      ],
    });
  });

  it("shareOrgSanctionsScreen accepts the empty-matches case (clear screen)", async () => {
    const fetchImpl = makeFetch(200, {
      screenId: "22222222-2222-4222-8222-222222222222",
      status: "created",
    });
    const c = createProcurClient({
      ...BASE_CONFIG,
      fetchImpl,
      log: silentLog(),
    });
    await c.shareOrgSanctionsScreen({
      entitySlug: "vector-trade-capital",
      vexTenantId: "01HSEEDWRK0000000000000001",
      screenId: "22222222-2222-4222-8222-222222222222",
      legalName: "Vector Trade Capital",
      status: "clear",
      sourcesChecked: ["us_csl", "eu", "uk_ofsi"],
      matches: [],
      screenedAt: "2026-05-01T03:00:00.000Z",
    });
    const [, init] = (fetchImpl as unknown as {
      mock: { calls: [string, RequestInit][] };
    }).mock.calls[0]!;
    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(body["matches"]).toEqual([]);
    expect(body["status"]).toBe("clear");
    // vex_tenant_id + screen_id are required on the empty-matches
    // path too — they're the dedupe key, not a per-match attribute.
    expect(body["vex_tenant_id"]).toBe("01HSEEDWRK0000000000000001");
    expect(body["screen_id"]).toBe("22222222-2222-4222-8222-222222222222");
  });

  it("shareOrgSanctionsScreen stays disabled-safe when procur isn't configured", async () => {
    const c = createProcurClient({
      baseUrl: null,
      apiToken: null,
      log: silentLog(),
    });
    const result = await c.shareOrgSanctionsScreen({
      entitySlug: "x",
      vexTenantId: "tenant-x",
      screenId: "33333333-3333-4333-8333-333333333333",
      legalName: "X",
      status: "clear",
      sourcesChecked: ["us_csl"],
      matches: [],
      screenedAt: "2026-05-01T03:00:00.000Z",
    });
    expect(result).toEqual({ ok: false, reason: "disabled" });
  });

  it("reportMatchOutcome posts a snake-cased payload to /intelligence/match-outcome", async () => {
    const fetchImpl = makeFetch(200, {
      procurOpportunityId: "OPP-9001",
      status: "recorded",
    });
    const c = createProcurClient({
      ...BASE_CONFIG,
      fetchImpl,
      log: silentLog(),
    });
    const result = await c.reportMatchOutcome({
      procurOpportunityId: "OPP-9001",
      outcome: "created",
      vexDealId: "01HD0000000000000000000001",
      vexDealRef: "VTC-2026-003",
      outcomeNote: "Operator approved at 14:02 CST",
      reportedAt: "2026-05-04T19:02:00.000Z",
    });
    expect(result.ok).toBe(true);

    const [url, init] = (fetchImpl as unknown as {
      mock: { calls: [string, RequestInit][] };
    }).mock.calls[0]!;
    expect(url).toBe(
      "https://procur.example.com/api/intelligence/match-outcome",
    );
    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(body).toEqual({
      procur_opportunity_id: "OPP-9001",
      outcome: "created",
      vex_deal_id: "01HD0000000000000000000001",
      vex_deal_ref: "VTC-2026-003",
      outcome_note: "Operator approved at 14:02 CST",
      reported_at: "2026-05-04T19:02:00.000Z",
      source: "vex",
    });
  });

  it("reportMatchOutcome serializes nulls explicitly so procur can distinguish 'no_engagement' (no deal) from 'created'", async () => {
    const fetchImpl = makeFetch(200, {
      procurOpportunityId: "OPP-7777",
      status: "recorded",
    });
    const c = createProcurClient({
      ...BASE_CONFIG,
      fetchImpl,
      log: silentLog(),
    });
    await c.reportMatchOutcome({
      procurOpportunityId: "OPP-7777",
      outcome: "no_engagement",
      reportedAt: "2026-05-04T19:02:00.000Z",
    });
    const [, init] = (fetchImpl as unknown as {
      mock: { calls: [string, RequestInit][] };
    }).mock.calls[0]!;
    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(body["outcome"]).toBe("no_engagement");
    expect(body["vex_deal_id"]).toBeNull();
    expect(body["vex_deal_ref"]).toBeNull();
    expect(body["outcome_note"]).toBeNull();
  });

  it("reportMatchOutcome stays disabled-safe when procur isn't configured", async () => {
    const c = createProcurClient({
      baseUrl: null,
      apiToken: null,
      log: silentLog(),
    });
    const result = await c.reportMatchOutcome({
      procurOpportunityId: "OPP-1",
      outcome: "closed_won",
      reportedAt: "2026-05-04T19:02:00.000Z",
    });
    expect(result).toEqual({ ok: false, reason: "disabled" });
  });
});

describe("buildProcurQueryHash", () => {
  it("produces identical hashes regardless of key order", () => {
    const a = buildProcurQueryHash("analyze_supplier", {
      supplierName: "Acme",
      yearsLookback: 2,
    });
    const b = buildProcurQueryHash("analyze_supplier", {
      yearsLookback: 2,
      supplierName: "Acme",
    });
    expect(a).toBe(b);
  });

  it("produces identical hashes regardless of array element order", () => {
    const a = buildProcurQueryHash("find_distressed", {
      countries: ["US", "DO", "JM"],
    });
    const b = buildProcurQueryHash("find_distressed", {
      countries: ["JM", "US", "DO"],
    });
    expect(a).toBe(b);
  });

  it("ignores null and undefined values", () => {
    const a = buildProcurQueryHash("analyze_supplier", {
      supplierName: "Acme",
      yearsLookback: undefined,
      categoryFilter: null,
    });
    const b = buildProcurQueryHash("analyze_supplier", {
      supplierName: "Acme",
    });
    expect(a).toBe(b);
  });

  it("differs across tools even with the same args", () => {
    const a = buildProcurQueryHash("analyze_supplier", { supplierName: "Acme" });
    const b = buildProcurQueryHash("analyze_buyer_pricing", {
      supplierName: "Acme",
    });
    expect(a).not.toBe(b);
  });

  it("includes the tool name in the hash output", () => {
    const a = buildProcurQueryHash("analyze_supplier", { supplierName: "Acme" });
    expect(a).toContain("analyze_supplier:");
  });
});
