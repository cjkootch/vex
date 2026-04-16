import {
  getServiceAccountAccessToken,
  parseServiceAccountJson,
  type GoogleServiceAccount,
} from "./google-auth.js";

/**
 * Google Ads — offline-conversion uploader.
 *
 * Uses the Google Ads API v17 `customers/<id>:uploadClickConversions` endpoint
 * (the modern replacement for the legacy Conversions API). For
 * cross-account uploads, the optional `loginCustomerId` is sent as the
 * `login-customer-id` header per the Ads API auth spec.
 *
 * Sprint 8 only ships the offline-conversion path because that's all the
 * LeadWonWorkflow needs; the broader Ads management surface stays out.
 */

const ADS_API_VERSION = "v17";
const ADS_BASE = `https://googleads.googleapis.com/${ADS_API_VERSION}`;
const ADS_SCOPE = "https://www.googleapis.com/auth/adwords";

export interface GoogleAdsAdapterDeps {
  serviceAccount: string | GoogleServiceAccount;
  /** Required by the Ads API for any RPC. */
  developerToken: string;
  /** Manager (MCC) account id when uploading to a child account. */
  loginCustomerId?: string;
  fetchImpl?: typeof fetch;
}

export interface OfflineConversionParams {
  /** Customer (Ads) account that owns the conversion action. Digits only, no dashes. */
  customerId: string;
  /** Resource name of the conversion action: `customers/<id>/conversionActions/<id>`. */
  conversionActionName: string;
  /** Click identifier captured at lead capture time (UTM query / form hidden field). */
  gclid: string;
  /** ISO-8601 with timezone offset, e.g. `2026-08-03T14:30:00+00:00`. */
  conversionDateTime: string;
  conversionValue: number;
  currencyCode: string;
}

export interface OfflineConversionResult {
  partialFailureError?: { message: string } | null;
  results?: { gclidDateTimePair?: { gclid: string } }[];
}

export class GoogleAdsAdapter {
  private readonly serviceAccount: GoogleServiceAccount;
  private readonly fetcher: typeof fetch;

  constructor(private readonly deps: GoogleAdsAdapterDeps) {
    this.serviceAccount =
      typeof deps.serviceAccount === "string"
        ? parseServiceAccountJson(deps.serviceAccount)
        : deps.serviceAccount;
    this.fetcher = deps.fetchImpl ?? globalThis.fetch.bind(globalThis);
  }

  async sendOfflineConversion(params: OfflineConversionParams): Promise<OfflineConversionResult> {
    const token = await getServiceAccountAccessToken(
      this.serviceAccount,
      ADS_SCOPE,
      this.fetcher,
    );
    const url = `${ADS_BASE}/customers/${encodeURIComponent(params.customerId)}:uploadClickConversions`;
    const headers: Record<string, string> = {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      "developer-token": this.deps.developerToken,
    };
    if (this.deps.loginCustomerId) {
      headers["login-customer-id"] = this.deps.loginCustomerId;
    }
    const body = {
      conversions: [
        {
          conversionAction: params.conversionActionName,
          gclid: params.gclid,
          conversionDateTime: params.conversionDateTime,
          conversionValue: params.conversionValue,
          currencyCode: params.currencyCode,
        },
      ],
      partialFailure: true,
      validateOnly: false,
    };
    const response = await this.fetcher(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });
    if (!response.ok) {
      const text = await response.text();
      throw new Error(`google ads ${response.status}: ${text.slice(0, 500)}`);
    }
    return (await response.json()) as OfflineConversionResult;
  }
}
