import { Controller, Get, Inject, Param, UseGuards } from "@nestjs/common";
import { JwtAuthGuard, TenantContext } from "../auth/index.js";
import { MarketingService } from "./marketing.service.js";

@Controller("marketing")
@UseGuards(JwtAuthGuard)
export class MarketingController {
  constructor(
    @Inject(TenantContext) private readonly tenant: TenantContext,
    @Inject(MarketingService) private readonly service: MarketingService,
  ) {}

  @Get("overview")
  async overview() {
    const overview = await this.service.overview(
      this.tenant.tenantId,
      this.tenant.workspaceId,
    );
    return overview;
  }

  @Get("campaigns/:id")
  async campaign(@Param("id") id: string) {
    const detail = await this.service.campaign(this.tenant.tenantId, id);
    return detail;
  }

  @Get("anomalies")
  async anomalies() {
    const anomalies = await this.service.anomalies(this.tenant.tenantId);
    return { anomalies };
  }
}
