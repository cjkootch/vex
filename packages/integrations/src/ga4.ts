import {
  getServiceAccountAccessToken,
  parseServiceAccountJson,
  type GoogleServiceAccount,
} from "./google-auth.js";

/**
 * GA4 Data API v1 adapter. Service-account auth, three methods:
 *   - runReport (standard report)
 *   - runRealtimeReport (live active-users-style metrics)
 *   - batchRunReports (up to 5 reports in one round trip)
 *
 * Rate limit handling: 429 responses are retried with exponential backoff up
 * to 3 times (1s, 2s, 4s). Other errors throw with the response body.
 */

const GA4_BASE = "https://analyticsdata.googleapis.com/v1beta";
const GA4_SCOPE = "https://www.googleapis.com/auth/analytics.readonly";
const MAX_RETRIES = 3;

export interface GA4Dimension {
  name: string;
}
export interface GA4Metric {
  name: string;
}
export interface GA4DateRange {
  startDate: string;
  endDate: string;
}
export interface GA4DimensionValue {
  value: string;
}
export interface GA4MetricValue {
  value: string;
}
export interface GA4Row {
  dimensionValues: GA4DimensionValue[];
  metricValues: GA4MetricValue[];
}
export interface GA4Report {
  dimensionHeaders: { name: string }[];
  metricHeaders: { name: string; type?: string }[];
  rows: GA4Row[];
  rowCount?: number;
}
export interface GA4RealtimeReport {
  dimensionHeaders: { name: string }[];
  metricHeaders: { name: string; type?: string }[];
  rows: GA4Row[];
}

export interface GA4ReportRequest {
  dimensions: GA4Dimension[];
  metrics: GA4Metric[];
  dateRanges: GA4DateRange[];
  limit?: number;
}

export interface GA4AdapterDeps {
  /** Stringified service account JSON, or a parsed object. */
  serviceAccount: string | GoogleServiceAccount;
  /** Optional fetch override for tests; defaults to global fetch. */
  fetchImpl?: typeof fetch;
  /** Optional sleep override for tests so retries don't actually wait. */
  sleepImpl?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((r) => setTimeout(r, ms));

export class GA4Adapter {
  private readonly serviceAccount: GoogleServiceAccount;
  private readonly fetcher: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(deps: GA4AdapterDeps) {
    this.serviceAccount =
      typeof deps.serviceAccount === "string"
        ? parseServiceAccountJson(deps.serviceAccount)
        : deps.serviceAccount;
    this.fetcher = deps.fetchImpl ?? globalThis.fetch.bind(globalThis);
    this.sleep = deps.sleepImpl ?? defaultSleep;
  }

  async runReport(
    propertyId: string,
    dimensions: string[],
    metrics: string[],
    dateRange: GA4DateRange,
  ): Promise<GA4Report> {
    const body = {
      dimensions: dimensions.map((name) => ({ name })),
      metrics: metrics.map((name) => ({ name })),
      dateRanges: [dateRange],
    };
    return this.post<GA4Report>(
      `${GA4_BASE}/properties/${encodeURIComponent(propertyId)}:runReport`,
      body,
    );
  }

  async runRealtimeReport(
    propertyId: string,
    dimensions: string[],
    metrics: string[],
  ): Promise<GA4RealtimeReport> {
    const body = {
      dimensions: dimensions.map((name) => ({ name })),
      metrics: metrics.map((name) => ({ name })),
    };
    return this.post<GA4RealtimeReport>(
      `${GA4_BASE}/properties/${encodeURIComponent(propertyId)}:runRealtimeReport`,
      body,
    );
  }

  async batchRunReports(
    propertyId: string,
    requests: GA4ReportRequest[],
  ): Promise<GA4Report[]> {
    if (requests.length === 0) return [];
    const body = { requests };
    const response = await this.post<{ reports: GA4Report[] }>(
      `${GA4_BASE}/properties/${encodeURIComponent(propertyId)}:batchRunReports`,
      body,
    );
    return response.reports ?? [];
  }

  private async post<T>(url: string, body: unknown): Promise<T> {
    let lastError: Error | null = null;
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      const token = await getServiceAccountAccessToken(
        this.serviceAccount,
        GA4_SCOPE,
        this.fetcher,
      );
      const response = await this.fetcher(url, {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(body),
      });
      if (response.status === 429) {
        const delay = 2 ** attempt * 1000;
        lastError = new Error(`ga4 429 rate limited; retrying in ${delay}ms`);
        if (attempt === MAX_RETRIES) break;
        await this.sleep(delay);
        continue;
      }
      if (!response.ok) {
        const text = await response.text();
        throw new Error(`ga4 ${response.status}: ${text.slice(0, 500)}`);
      }
      return (await response.json()) as T;
    }
    throw lastError ?? new Error("ga4 request failed after retries");
  }
}
