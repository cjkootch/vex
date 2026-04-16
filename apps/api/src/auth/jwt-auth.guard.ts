import { Inject, Injectable, UnauthorizedException } from "@nestjs/common";
import type { CanActivate, ExecutionContext } from "@nestjs/common";
import type { FastifyRequest } from "fastify";
import { decode } from "@auth/core/jwt";
import type { VexJwt } from "./types.js";

export const NEXTAUTH_SECRET_TOKEN = Symbol("NEXTAUTH_SECRET");
/** Salt NextAuth uses for the encryption key derivation. Must match the
 * cookie name used by apps/web — for non-secure cookies that's plain
 * `authjs.session-token`. We use the same default here. */
export const NEXTAUTH_SALT = "authjs.session-token";

/**
 * Validate a NextAuth-issued JWE Bearer token and attach the decoded claims
 * to `req.user`. Returns 401 on any failure with no detail leak.
 *
 * NextAuth v5 (Auth.js) encrypts session tokens with A256CBC-HS512; the
 * helper below uses the same `decode` Auth.js calls internally.
 */
@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(@Inject(NEXTAUTH_SECRET_TOKEN) private readonly secret: string) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<FastifyRequest>();
    const header = req.headers["authorization"];
    const token = extractBearer(header);
    if (!token) throw new UnauthorizedException("missing_token");

    try {
      const payload = await decode({
        token,
        secret: this.secret,
        salt: NEXTAUTH_SALT,
      });
      if (!payload) throw new Error("empty_payload");
      const claims = toVexJwt(payload);
      req.user = claims;
      return true;
    } catch {
      throw new UnauthorizedException("invalid_token");
    }
  }
}

function extractBearer(
  header: string | string[] | undefined,
): string | undefined {
  if (!header) return undefined;
  const value = Array.isArray(header) ? header[0] : header;
  if (!value) return undefined;
  const match = /^Bearer\s+(.+)$/i.exec(value.trim());
  return match?.[1];
}

function toVexJwt(payload: Record<string, unknown>): VexJwt {
  const userId = stringClaim(payload, "userId");
  const tenantId = stringClaim(payload, "tenantId");
  const workspaceId = stringClaim(payload, "workspaceId");
  const role = stringClaim(payload, "role");
  if (!isRole(role)) throw new Error("invalid_role");
  if (!userId || !tenantId || !workspaceId) throw new Error("missing_claim");

  const out: VexJwt = { userId, tenantId, workspaceId, role };
  const email = payload["email"];
  if (typeof email === "string") out.email = email;
  const name = payload["name"];
  if (typeof name === "string" || name === null) out.name = name as string | null;
  return out;
}

function stringClaim(payload: Record<string, unknown>, key: string): string {
  const v = payload[key];
  return typeof v === "string" ? v : "";
}

function isRole(role: string): role is VexJwt["role"] {
  return role === "owner" || role === "admin" || role === "member" || role === "viewer";
}
