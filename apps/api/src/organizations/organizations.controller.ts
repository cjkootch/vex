import { Controller, Get, Inject, Param, UseGuards } from "@nestjs/common";
import { JwtAuthGuard, TenantContext } from "../auth/index.js";

/**
 * Sample protected controller that exercises the auth + tenant pipeline.
 * Sprint 6 will replace the body with real organization handlers; for now
 * the routes echo the request's tenant so tests can assert isolation.
 *
 * `@Inject(TenantContext)` is explicit because under NodeNext + `.js`
 * import suffixes, TypeScript's reflect-metadata emit can erase the
 * constructor-parameter type information that Nest's implicit DI relies on.
 */
@Controller("organizations")
@UseGuards(JwtAuthGuard)
export class OrganizationsController {
  constructor(@Inject(TenantContext) private readonly tenant: TenantContext) {}

  @Get()
  list(): { tenantId: string; workspaceId: string; userId: string } {
    return {
      tenantId: this.tenant.tenantId,
      workspaceId: this.tenant.workspaceId,
      userId: this.tenant.userId,
    };
  }

  @Get(":id")
  byId(@Param("id") id: string): { tenantId: string; id: string } {
    return { tenantId: this.tenant.tenantId, id };
  }
}
