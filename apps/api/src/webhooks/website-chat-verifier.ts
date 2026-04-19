import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Website-chat webhook verifier. Simpler than the Resend/Svix scheme —
 * the VTC website signs the raw body + a timestamp using a shared
 * secret and sends two headers:
 *
 *   X-VTC-Timestamp: <unix seconds>
 *   X-VTC-Signature: hex(HMAC-SHA256(secret, `${timestamp}.${rawBody}`))
 *
 * Reject deliveries older than {@link MAX_AGE_SECONDS} to bound replay.
 */

const MAX_AGE_SECONDS = 5 * 60;

export type WebsiteChatVerifyResult =
  | { ok: true }
  | { ok: false; reason: WebsiteChatVerifyFailure };

export type WebsiteChatVerifyFailure =
  | "missing_headers"
  | "stale_timestamp"
  | "bad_signature";

export interface WebsiteChatVerifierOptions {
  secret: string;
  now?: () => Date;
}

export class WebsiteChatVerifier {
  private readonly key: Buffer;
  private readonly now: () => Date;

  constructor(options: WebsiteChatVerifierOptions) {
    this.key = Buffer.from(options.secret, "utf8");
    this.now = options.now ?? (() => new Date());
  }

  verify(
    headers: Record<string, string | string[] | undefined>,
    rawBody: Buffer,
  ): WebsiteChatVerifyResult {
    const timestamp = headerValue(headers, "x-vtc-timestamp");
    const signature = headerValue(headers, "x-vtc-signature");
    if (!timestamp || !signature) {
      return { ok: false, reason: "missing_headers" };
    }
    const ts = Number(timestamp);
    if (!Number.isFinite(ts)) {
      return { ok: false, reason: "stale_timestamp" };
    }
    const ageSeconds = Math.abs(
      Math.floor(this.now().getTime() / 1000) - ts,
    );
    if (ageSeconds > MAX_AGE_SECONDS) {
      return { ok: false, reason: "stale_timestamp" };
    }
    const signedPayload = `${timestamp}.${rawBody.toString("utf8")}`;
    const expected = createHmac("sha256", this.key)
      .update(signedPayload)
      .digest();
    let actual: Buffer;
    try {
      actual = Buffer.from(signature, "hex");
    } catch {
      return { ok: false, reason: "bad_signature" };
    }
    if (
      actual.length !== expected.length ||
      !timingSafeEqual(actual, expected)
    ) {
      return { ok: false, reason: "bad_signature" };
    }
    return { ok: true };
  }
}

function headerValue(
  headers: Record<string, string | string[] | undefined>,
  name: string,
): string | undefined {
  const direct = headers[name];
  if (typeof direct === "string") return direct;
  if (Array.isArray(direct) && direct.length > 0) return direct[0];
  for (const k of Object.keys(headers)) {
    if (k.toLowerCase() === name) {
      const v = headers[k];
      if (typeof v === "string") return v;
      if (Array.isArray(v) && v.length > 0) return v[0];
    }
  }
  return undefined;
}

/**
 * Test + replay helper. Produces the headers the VTC website would send
 * for a given body. Don't call from request handlers.
 */
export function signWebsiteChatForTest(
  secret: string,
  rawBody: Buffer,
  options?: { timestamp?: number },
): Record<string, string> {
  const timestamp = String(
    options?.timestamp ?? Math.floor(Date.now() / 1000),
  );
  const sig = createHmac("sha256", Buffer.from(secret, "utf8"))
    .update(`${timestamp}.${rawBody.toString("utf8")}`)
    .digest("hex");
  return {
    "x-vtc-timestamp": timestamp,
    "x-vtc-signature": sig,
  };
}
