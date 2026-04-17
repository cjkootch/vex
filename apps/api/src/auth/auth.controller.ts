import { Controller, Get, Inject, UseGuards } from "@nestjs/common";
import { JwtAuthGuard } from "./jwt-auth.guard.js";
import { TenantContext } from "./tenant-context.service.js";

/**
 * Tiny "auth plumbing works" endpoint. Returns the tenant/user/workspace
 * ids the JwtAuthGuard decoded — used by `test/auth/auth.test.ts` to
 * assert the full auth pipeline (JWE decode → guard allow → tenant
 * decorator population) without coupling the assertion to any business
 * controller. Pre-Sprint-14 the tests hit /organizations for the same
 * purpose, which stopped working once that controller started proxying
 * real DB reads.
 */
@Controller("_auth")
@UseGuards(JwtAuthGuard)
export class AuthController {
  constructor(
    @Inject(TenantContext) private readonly tenant: TenantContext,
  ) {}

  @Get("whoami")
  whoami(): { tenantId: string; workspaceId: string; userId: string } {
    return {
      tenantId: this.tenant.tenantId,
      workspaceId: this.tenant.workspaceId,
      userId: this.tenant.userId,
    };
  }
}
