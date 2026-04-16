import { Inject, Injectable, Logger, UnauthorizedException } from "@nestjs/common";
import type { CanActivate, ExecutionContext } from "@nestjs/common";
import type { FastifyRequest } from "fastify";
import { decode } from "@auth/core/jwt";
import type { VexJwt } from "./types.js";

export const NEXTAUTH_SECRET_TOKEN = Symbol("NEXTAUTH_SECRET");

/**
 * NextAuth derives the encryption key from (secret + salt). The salt is the
 * cookie name, which varies by transport:
 *   - `authjs.session-token`         (http / dev)
 *   - `__Secure-authjs.session-token` (https / prod)
 * We try both so the guard works in both environments without needing
 * per-env config.
 */
const NEXTAUTH_SALTS = [
  "authjs.session-token",
  "__Secure-authjs.session-token",
] as const;

/**
 * Validate a NextAuth-issued JWE Bearer token and attach the decoded claims
 * to `req.user`. Returns 401 on any failure with no detail leak.
 */
@Injectable()
export class JwtAuthGuard implements CanActivate {
  private readonly log = new Logger(JwtAuthGuard.name);

  constructor(@Inject(NEXTAUTH_SECRET_TOKEN) private readonly secret: string) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<FastifyRequest>();
    const header = req.headers["authorization"];
    const token = extractBearer(header);
    if (!token) {
      this.log.warn(
        `auth: missing bearer (have_auth_header=${Boolean(header)} secret_len=${this.secret.length})`,
      );
      throw new UnauthorizedException("missing_token");
    }

    let payload: Record<string, unknown> | null = null;
    let lastErr = "";
    for (const salt of NEXTAUTH_SALTS) {
      try {
        const result = await decode({ token, secret: this.secret, salt });
        if (result) {
          payload = result;
          break;
        }
        lastErr = "empty_payload";
      } catch (e) {
        lastErr = (e as Error).message;
      }
    }
    if (!payload) {
      this.log.warn(
        `auth: decode failed (token_len=${token.length} secret_len=${this.secret.length} err=${lastErr})`,
      );
      throw new UnauthorizedException("invalid_token");
    }

    try {
      req.user = toVexJwt(payload);
      return true;
    } catch (e) {
      this.log.warn(`auth: claims invalid: ${(e as Error).message}`);
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
