import { Injectable, type ExecutionContext } from "@nestjs/common";
import { ThrottlerGuard } from "@nestjs/throttler";
import type { FastifyRequest } from "fastify";

/**
 * Rate-limit key resolver: authenticated requests are keyed by tenant_id so
 * one noisy tenant can't starve the others; unauthenticated requests fall
 * back to remote IP (webhooks should be excluded from the global guard via
 * `@SkipThrottle()` on their controllers).
 *
 * Nest 10 + @nestjs/throttler 6 expose `getTracker` as an async method; we
 * await nothing but match the signature.
 */
@Injectable()
export class TenantThrottlerGuard extends ThrottlerGuard {
  protected override async getTracker(req: FastifyRequest): Promise<string> {
    const user = (req as unknown as { user?: { tenantId?: string } }).user;
    if (user?.tenantId) return `tenant:${user.tenantId}`;
    const ip = req.ip ?? "unknown";
    return `ip:${ip}`;
  }

  protected override async shouldSkip(_context: ExecutionContext): Promise<boolean> {
    // Controller-level `@SkipThrottle()` decorators handle webhook
    // exemptions; we don't short-circuit here.
    return false;
  }
}
