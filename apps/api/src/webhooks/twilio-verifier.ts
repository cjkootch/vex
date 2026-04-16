import { validateRequest } from "twilio";

export interface TwilioVerifierOptions {
  authToken: string;
}

export type TwilioVerifyResult = { ok: true } | { ok: false; reason: TwilioVerifyFailure };
export type TwilioVerifyFailure = "missing_signature" | "invalid_signature";

/**
 * Twilio signs the full request URL plus the form-encoded body params.
 * Validation must use the *exact* URL Twilio sent the request to (including
 * query string), so the controller must reconstruct it from the request's
 * `headers.host` and `originalUrl`.
 */
export class TwilioVerifier {
  constructor(private readonly options: TwilioVerifierOptions) {}

  verify(
    headers: Record<string, string | string[] | undefined>,
    fullUrl: string,
    params: Record<string, string>,
  ): TwilioVerifyResult {
    const sig = pickHeader(headers, "x-twilio-signature");
    if (!sig) return { ok: false, reason: "missing_signature" };

    const valid = validateRequest(this.options.authToken, sig, fullUrl, params);
    return valid ? { ok: true } : { ok: false, reason: "invalid_signature" };
  }
}

function pickHeader(
  headers: Record<string, string | string[] | undefined>,
  name: string,
): string | undefined {
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === name) {
      const v = headers[key];
      if (typeof v === "string") return v;
      if (Array.isArray(v) && v.length > 0) return v[0];
    }
  }
  return undefined;
}
