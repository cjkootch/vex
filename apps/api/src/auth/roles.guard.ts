import { ForbiddenException, Inject, Injectable, SetMetadata } from "@nestjs/common";
import type { CanActivate, ExecutionContext } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import type { FastifyRequest } from "fastify";
import type { VexJwt } from "./types.js";

const REQUIRE_ROLE_KEY = "vex.require_role";

/**
 * Decorator that marks a route or controller as requiring at least the given
 * role. Roles are ordered: viewer < member < admin < owner. Unmarked routes
 * accept any authenticated user.
 */
export const RequireRole = (role: VexJwt["role"]) => SetMetadata(REQUIRE_ROLE_KEY, role);

const ROLE_RANK: Record<VexJwt["role"], number> = {
  viewer: 0,
  member: 1,
  admin: 2,
  owner: 3,
};

@Injectable()
export class RolesGuard implements CanActivate {
  constructor(@Inject(Reflector) private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const required = this.reflector.getAllAndOverride<VexJwt["role"] | undefined>(
      REQUIRE_ROLE_KEY,
      [context.getHandler(), context.getClass()],
    );
    if (!required) return true;

    const req = context.switchToHttp().getRequest<FastifyRequest>();
    const user = req.user;
    if (!user) throw new ForbiddenException("auth_required");
    if (ROLE_RANK[user.role] < ROLE_RANK[required]) {
      throw new ForbiddenException("insufficient_role");
    }
    return true;
  }
}
