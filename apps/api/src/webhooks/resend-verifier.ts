import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Resend webhook signing uses Svix's scheme:
 *   - svix-id: webhook delivery id
 *   - svix-timestamp: unix seconds
 *   - svix-signature: space-separated "v1,<base64>" entries (one per signing key)
 *
 * Signed payload = `${svix-id}.${svix-timestamp}.${rawBody}` (utf-8).
 * HMAC-SHA256 with secret bytes (the Resend dashboard returns
 * `whsec_<base64>` — strip the prefix, base64-decode the rest to get bytes).
 *
 * Reject deliveries older than {@link MAX_AGE_SECONDS} seconds to limit replay
 * attacks even if a signature leaks.
 */

const MAX_AGE_SECONDS = 5 * 60;

export type ResendVerifyResult =
  | { ok: true }
  | { ok: false; reason: ResendVerifyFailure };

export type ResendVerifyFailure =
  | "missing_headers"
  | "stale_timestamp"
  | "no_valid_signature"
  | "malformed_secret"
  | "malformed_signature";

export interface ResendVerifierOptions {
  /** `whsec_...` secret as displayed in the Resend dashboard. */
  secret: string;
  /** Override for tests; defaults to wall-clock time. */
  now?: () => Date;
}

export class ResendVerifier {
  private readonly key: Buffer;
  private readonly now: () => Date;

  constructor(options: ResendVerifierOptions) {
    this.key = decodeSecret(options.secret);
    this.now = options.now ?? (() => new Date());
  }

  verify(headers: Record<string, string | string[] | undefined>, rawBody: Buffer): ResendVerifyResult {
    const id = headerValue(headers, "svix-id");
    const timestamp = headerValue(headers, "svix-timestamp");
    const signature = headerValue(headers, "svix-signature");
    if (!id || !timestamp || !signature) {
      return { ok: false, reason: "missing_headers" };
    }

    const ts = Number(timestamp);
    if (!Number.isFinite(ts)) {
      return { ok: false, reason: "stale_timestamp" };
    }
    const ageSeconds = Math.abs(Math.floor(this.now().getTime() / 1000) - ts);
    if (ageSeconds > MAX_AGE_SECONDS) {
      return { ok: false, reason: "stale_timestamp" };
    }

    const signedPayload = `${id}.${timestamp}.${rawBody.toString("utf8")}`;
    const expected = createHmac("sha256", this.key).update(signedPayload).digest();

    const candidates = signature
      .split(" ")
      .map((s) => s.trim())
      .filter(Boolean);

    let parsedAny = false;
    for (const candidate of candidates) {
      const parts = candidate.split(",");
      if (parts.length !== 2) continue;
      const [version, sigB64] = parts;
      if (version !== "v1" || !sigB64) continue;
      parsedAny = true;
      let actual: Buffer;
      try {
        actual = Buffer.from(sigB64, "base64");
      } catch {
        continue;
      }
      if (actual.length === expected.length && timingSafeEqual(actual, expected)) {
        return { ok: true };
      }
    }

    if (!parsedAny) {
      return { ok: false, reason: "malformed_signature" };
    }
    return { ok: false, reason: "no_valid_signature" };
  }
}

function headerValue(
  headers: Record<string, string | string[] | undefined>,
  name: string,
): string | undefined {
  const direct = headers[name];
  if (typeof direct === "string") return direct;
  if (Array.isArray(direct) && direct.length > 0) return direct[0];
  // Some clients title-case headers
  for (const k of Object.keys(headers)) {
    if (k.toLowerCase() === name) {
      const v = headers[k];
      if (typeof v === "string") return v;
      if (Array.isArray(v) && v.length > 0) return v[0];
    }
  }
  return undefined;
}

function decodeSecret(secret: string): Buffer {
  const raw = secret.startsWith("whsec_") ? secret.slice(6) : secret;
  const buf = Buffer.from(raw, "base64");
  if (buf.length === 0) {
    throw new Error("Resend webhook secret could not be decoded as base64");
  }
  return buf;
}

/**
 * Helper used by tests and the replay CLI. Produces the headers a Resend
 * webhook would carry for the given body — never call this from request
 * handlers.
 */
export function signResendForTest(
  secret: string,
  rawBody: Buffer,
  options?: { id?: string; timestamp?: number },
): Record<string, string> {
  const key = decodeSecret(secret);
  const id = options?.id ?? "msg_test_00000000000000000000000";
  const timestamp = String(options?.timestamp ?? Math.floor(Date.now() / 1000));
  const signedPayload = `${id}.${timestamp}.${rawBody.toString("utf8")}`;
  const sig = createHmac("sha256", key).update(signedPayload).digest("base64");
  return {
    "svix-id": id,
    "svix-timestamp": timestamp,
    "svix-signature": `v1,${sig}`,
  };
}
