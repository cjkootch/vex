import {
  Inject,
  Injectable,
  Logger,
  UnauthorizedException,
} from "@nestjs/common";
import type { CanActivate, ExecutionContext } from "@nestjs/common";
import type { FastifyRequest } from "fastify";
import { timingSafeEqual } from "node:crypto";

export const VEX_API_TOKEN_SECRET = Symbol("VEX_API_TOKEN_SECRET");

/**
 * Service-to-service bearer auth for ingest endpoints (procur today,
 * other upstream pushers tomorrow). Compares `Authorization: Bearer
 * <token>` against `VEX_API_TOKEN` from env using a constant-time
 * compare so timing attacks can't leak prefix matches.
 *
 * Distinct from {@link JwtAuthGuard} which decodes a NextAuth JWE and
 * pins the request to a specific user/tenant. Procur calls don't
 * carry a user — the tenant is resolved server-side from the
 * IngestModule's `defaultTenantId`.
 */
@Injectable()
export class ApiTokenGuard implements CanActivate {
  private readonly log = new Logger(ApiTokenGuard.name);

  constructor(
    @Inject(VEX_API_TOKEN_SECRET)
    private readonly expectedToken: string | null,
  ) {}

  canActivate(context: ExecutionContext): boolean {
    if (!this.expectedToken) {
      this.log.warn(
        "api-token guard: VEX_API_TOKEN unset; rejecting all calls",
      );
      throw new UnauthorizedException("api_token_not_configured");
    }
    const req = context.switchToHttp().getRequest<FastifyRequest>();
    const header = req.headers["authorization"];
    const value = Array.isArray(header) ? header[0] : header;
    if (!value) throw new UnauthorizedException("missing_token");
    const match = /^Bearer\s+(.+)$/i.exec(value.trim());
    const presented = match?.[1];
    if (!presented) throw new UnauthorizedException("missing_token");

    const expectedBuf = Buffer.from(this.expectedToken);
    const presentedBuf = Buffer.from(presented);
    if (presentedBuf.length !== expectedBuf.length) {
      throw new UnauthorizedException("invalid_token");
    }
    if (!timingSafeEqual(presentedBuf, expectedBuf)) {
      throw new UnauthorizedException("invalid_token");
    }
    return true;
  }
}
