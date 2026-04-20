import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Inject,
  Put,
  UseGuards,
} from "@nestjs/common";
import { z } from "zod";
import { UserRole } from "@vex/domain";
import { JwtAuthGuard, RequireRole, RolesGuard, TenantContext } from "../auth/index.js";
import { StrategyService } from "./strategy.service.js";

/**
 * Sprint S — operator-authored company strategy.
 *
 * Shape: every field is optional; an operator saves whatever they've
 * written so far. Empty strings + empty arrays are allowed and
 * normalise to "not populated" at read time. Server-side Zod validates
 * bounds (length / count) so we don't ship a 10kB mission statement.
 *
 * Auth: OWNER only. Strategy affects every chat response and every
 * proposed action for the whole workspace, so letting a regular member
 * rewrite it is not a reasonable default.
 */
const StrategyInputSchema = z
  .object({
    mission: z.string().max(2000).optional(),
    target_markets: z.array(z.string().min(1).max(200)).max(20).optional(),
    icp_buyers: z.string().max(2000).optional(),
    icp_suppliers: z.string().max(2000).optional(),
    brand_voice: z.string().max(2000).optional(),
    pricing_philosophy: z.string().max(2000).optional(),
    no_go_zones: z.array(z.string().min(1).max(200)).max(20).optional(),
    growth_priorities: z.array(z.string().min(1).max(200)).max(20).optional(),
    additional_guidance: z.string().max(5000).optional(),
  })
  .strict();

@Controller("strategy")
@UseGuards(JwtAuthGuard, RolesGuard)
@RequireRole(UserRole.Owner)
export class StrategyController {
  constructor(
    @Inject(TenantContext) private readonly tenant: TenantContext,
    @Inject(StrategyService) private readonly service: StrategyService,
  ) {}

  @Get()
  async getStrategy() {
    const strategy = await this.service.getStrategy(this.tenant.workspaceId);
    return { strategy };
  }

  @Put()
  async updateStrategy(@Body() raw: unknown) {
    const parsed = StrategyInputSchema.safeParse(raw);
    if (!parsed.success) throw new BadRequestException(parsed.error.message);
    const strategy = await this.service.updateStrategy(
      this.tenant.workspaceId,
      parsed.data,
      this.tenant.userId,
    );
    return { strategy };
  }
}
