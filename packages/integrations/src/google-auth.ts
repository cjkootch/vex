import { createSign } from "node:crypto";

/**
 * Minimal Google service-account OAuth 2.0 (RFC 7521) helper. We deliberately
 * avoid the full `googleapis` package because Sprint 8 only needs two endpoints
 * (GA4 Data API + Google Ads Data Manager), and pulling in the full client
 * would add ~100 deps and slow worker boot.
 *
 * Caches access tokens per (clientEmail, scope) until 60s before expiry.
 */
export interface GoogleServiceAccount {
  client_email: string;
  private_key: string;
  /** Optional — only used by Ads when impersonating a manager account. */
  project_id?: string;
}

export interface GoogleAccessToken {
  token: string;
  expiresAtMs: number;
}

const SAFETY_WINDOW_MS = 60_000;
const tokenCache = new Map<string, GoogleAccessToken>();

export function parseServiceAccountJson(raw: string): GoogleServiceAccount {
  const parsed = JSON.parse(raw) as Partial<GoogleServiceAccount>;
  if (!parsed.client_email || !parsed.private_key) {
    throw new Error("service account JSON missing client_email or private_key");
  }
  return {
    client_email: parsed.client_email,
    private_key: parsed.private_key,
    ...(parsed.project_id ? { project_id: parsed.project_id } : {}),
  };
}

/** Sign a JWT with the service account private key. */
function buildJwt(sa: GoogleServiceAccount, scope: string): string {
  const header = base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const now = Math.floor(Date.now() / 1000);
  const claims = base64url(
    JSON.stringify({
      iss: sa.client_email,
      scope,
      aud: "https://oauth2.googleapis.com/token",
      iat: now,
      exp: now + 3600,
    }),
  );
  const signingInput = `${header}.${claims}`;
  const signer = createSign("RSA-SHA256");
  signer.update(signingInput);
  signer.end();
  const signature = signer.sign(sa.private_key);
  return `${signingInput}.${base64urlBuffer(signature)}`;
}

function base64url(input: string): string {
  return Buffer.from(input, "utf8")
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}
function base64urlBuffer(buf: Buffer): string {
  return buf
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

/**
 * Exchange a JWT for an OAuth 2.0 access token. Uses the cache when a fresh
 * token (>60s remaining) is available for the same `(clientEmail, scope)`.
 */
export async function getServiceAccountAccessToken(
  sa: GoogleServiceAccount,
  scope: string,
  fetcher: typeof fetch = globalThis.fetch.bind(globalThis),
): Promise<string> {
  const cacheKey = `${sa.client_email}::${scope}`;
  const cached = tokenCache.get(cacheKey);
  if (cached && cached.expiresAtMs - Date.now() > SAFETY_WINDOW_MS) {
    return cached.token;
  }
  const jwt = buildJwt(sa, scope);
  const body = new URLSearchParams({
    grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
    assertion: jwt,
  });
  const response = await fetcher("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`google oauth token exchange failed (${response.status}): ${text}`);
  }
  const data = (await response.json()) as { access_token: string; expires_in: number };
  const expiresAtMs = Date.now() + data.expires_in * 1000;
  tokenCache.set(cacheKey, { token: data.access_token, expiresAtMs });
  return data.access_token;
}

/** Test hook — clear the access-token cache between tests. */
export function __resetGoogleAuthCache(): void {
  tokenCache.clear();
}
