/**
 * US Energy Information Administration (EIA) Open Data v2 adapter.
 *
 * Docs: https://www.eia.gov/opendata/documentation.php
 * Base: https://api.eia.gov/v2/
 *
 * The adapter is deliberately thin — it fetches one series at a time over a
 * date window, parses the response, and returns a normalized row shape that
 * the fuel-market-rate repository can persist without further transformation.
 *
 * Series IDs we care about for revenue-trading analysis. Exposed as
 * `FUEL_SERIES` so the agent/job layers share a single source of truth:
 *   - PET.RWTC.D   — Cushing WTI spot, $/bbl, daily
 *   - PET.RBRTE.D  — Europe Brent spot, $/bbl, daily
 *   - PET.EER_EPMRU_PF4_RGC_DPG.W — US regular gasoline retail, $/gal, weekly
 *   - PET.EER_EPD2D_PF4_Y35NY_DPG.W — NY Harbor ULSD spot, $/gal, weekly
 *   - NG.RNGWHHD.D — Henry Hub natural gas, $/MMBtu, daily
 */

export interface EiaDeps {
  apiKey: string;
  /** Optional fetch override for tests. Defaults to global `fetch`. */
  fetch?: typeof fetch;
  /** Base URL override, mainly for fixtures. */
  baseUrl?: string;
}

export interface EiaSeriesRow {
  seriesId: string;
  /** ISO date (YYYY-MM-DD) when period is daily, YYYY-MM-DD for weekly (week-ending). */
  period: string;
  /** Numeric value. EIA returns strings; we coerce. Null if they report `"."`. */
  value: number | null;
  /** Unit string from the EIA response, e.g. "dollars per barrel". */
  unit: string;
}

export interface EiaFetchParams {
  seriesId: string;
  /** ISO date (YYYY-MM-DD) inclusive. */
  start: string;
  /** ISO date (YYYY-MM-DD) inclusive. */
  end: string;
  /** Max rows; EIA caps at 5000 per request. */
  limit?: number;
}

export const FUEL_SERIES = {
  WTI: "PET.RWTC.D",
  BRENT: "PET.RBRTE.D",
  GASOLINE_RETAIL: "PET.EER_EPMRU_PF4_RGC_DPG.W",
  DIESEL_NY: "PET.EER_EPD2D_PF4_Y35NY_DPG.W",
  NATGAS_HH: "NG.RNGWHHD.D",
} as const;

export type FuelSeriesKey = keyof typeof FUEL_SERIES;

interface EiaRawResponse {
  response?: {
    data?: Array<Record<string, unknown>>;
  };
  error?: string;
}

export class EiaAdapter {
  private readonly apiKey: string;
  private readonly fetchImpl: typeof fetch;
  private readonly baseUrl: string;

  constructor(deps: EiaDeps) {
    this.apiKey = deps.apiKey;
    this.fetchImpl = deps.fetch ?? fetch;
    this.baseUrl = deps.baseUrl ?? "https://api.eia.gov/v2";
  }

  /**
   * Fetch a single series over `[start, end]`. Returns rows sorted oldest
   * first. Throws on HTTP failure or on an EIA-level error payload —
   * callers decide whether to retry.
   */
  async fetchSeries(params: EiaFetchParams): Promise<EiaSeriesRow[]> {
    const route = routeForSeries(params.seriesId);
    const url = new URL(`${this.baseUrl}${route}/data/`);
    url.searchParams.set("api_key", this.apiKey);
    url.searchParams.set("frequency", frequencyForSeries(params.seriesId));
    url.searchParams.append("data[]", "value");
    url.searchParams.append("facets[series][]", params.seriesId);
    url.searchParams.set("start", params.start);
    url.searchParams.set("end", params.end);
    url.searchParams.set("sort[0][column]", "period");
    url.searchParams.set("sort[0][direction]", "asc");
    url.searchParams.set("length", String(params.limit ?? 5000));

    const res = await this.fetchImpl(url.toString(), {
      method: "GET",
      headers: { Accept: "application/json" },
    });
    if (!res.ok) {
      throw new Error(`EIA request failed: ${res.status} ${res.statusText}`);
    }
    const body = (await res.json()) as EiaRawResponse;
    if (body.error) throw new Error(`EIA error: ${body.error}`);
    const rows = body.response?.data ?? [];
    return rows
      .map((row) => coerceRow(row, params.seriesId))
      .filter((r): r is EiaSeriesRow => r !== null);
  }
}

function routeForSeries(seriesId: string): string {
  // `PET.X.Y` → `/petroleum/pri/spt` style roots. EIA also accepts the
  // legacy facet-based query against `/seriesid/{id}` which is what we
  // use so we don't need to maintain a per-series route map.
  return `/seriesid/${encodeURIComponent(seriesId)}`;
}

function frequencyForSeries(seriesId: string): string {
  if (seriesId.endsWith(".W")) return "weekly";
  if (seriesId.endsWith(".M")) return "monthly";
  if (seriesId.endsWith(".A")) return "annual";
  return "daily";
}

function coerceRow(
  row: Record<string, unknown>,
  seriesId: string,
): EiaSeriesRow | null {
  const period = typeof row["period"] === "string" ? (row["period"] as string) : null;
  if (!period) return null;
  const raw = row["value"];
  let value: number | null;
  if (raw === null || raw === "." || raw === undefined) {
    value = null;
  } else if (typeof raw === "number") {
    value = raw;
  } else if (typeof raw === "string") {
    const parsed = Number(raw);
    value = Number.isFinite(parsed) ? parsed : null;
  } else {
    value = null;
  }
  const unit = typeof row["units"] === "string" ? (row["units"] as string) : "";
  return { seriesId, period, value, unit };
}
