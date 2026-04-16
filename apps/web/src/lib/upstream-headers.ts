import type { NextRequest } from "next/server";

/**
 * Forward apps/web headers to apps/api.
 *
 * Browser cookies aren't readable by apps/api (different origin), so we
 * lift the NextAuth session cookie value and re-send it as a `Bearer`
 * token in the Authorization header. The API's JwtAuthGuard decodes it
 * with the same NEXTAUTH_SECRET + salt.
 *
 * Cookie names (NextAuth v5 defaults):
 *   - `__Secure-authjs.session-token` on https
 *   - `authjs.session-token`          on http
 */
export function buildUpstreamHeaders(req: NextRequest): Headers {
  const out = new Headers();

  // Passthrough for test hooks + content negotiation.
  for (const [k, v] of req.headers.entries()) {
    if (k.startsWith("x-") || k === "content-type" || k === "accept") {
      out.set(k, v);
    }
  }

  // If the caller already sent Authorization (e.g. a service token in a test),
  // prefer that and skip the cookie lift.
  const incomingAuth = req.headers.get("authorization");
  if (incomingAuth) {
    out.set("authorization", incomingAuth);
    return out;
  }

  const sessionToken =
    req.cookies.get("__Secure-authjs.session-token")?.value ??
    req.cookies.get("authjs.session-token")?.value ??
    req.cookies.get("__Secure-next-auth.session-token")?.value ??
    req.cookies.get("next-auth.session-token")?.value;
  if (sessionToken) {
    out.set("authorization", `Bearer ${sessionToken}`);
  }

  return out;
}
