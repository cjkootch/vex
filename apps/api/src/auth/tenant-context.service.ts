import {
  Inject,
  Injectable,
  Scope,
  UnauthorizedException,
} from "@nestjs/common";
import { REQUEST } from "@nestjs/core";
import type { FastifyRequest } from "fastify";
import type { VexJwt } from "./types.js";

/**
 * Request-scoped: every controller invocation gets its own instance, so
 * reading `tenantId` is always tied to the current request's authenticated
 * user. JwtAuthGuard MUST run before any consumer of TenantContext.
 */
@Injectable({ scope: Scope.REQUEST })
export class TenantContext {
  constructor(@Inject(REQUEST) private readonly req: FastifyRequest) {}

  private requireUser(): VexJwt {
    if (!this.req.user) {
      throw new UnauthorizedException("auth_required");
    }
    return this.req.user;
  }

  get tenantId(): string {
    return this.requireUser().tenantId;
  }

  get workspaceId(): string {
    return this.requireUser().workspaceId;
  }

  get userId(): string {
    return this.requireUser().userId;
  }

  get role(): VexJwt["role"] {
    return this.requireUser().role;
  }
}
