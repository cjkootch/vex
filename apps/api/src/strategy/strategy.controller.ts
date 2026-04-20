import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Inject,
  InternalServerErrorException,
  Post,
  Put,
  UseGuards,
} from "@nestjs/common";
import { z } from "zod";
import { createId, UserRole } from "@vex/domain";
import { JwtAuthGuard, RequireRole, RolesGuard, TenantContext } from "../auth/index.js";
import { StrategyService } from "./strategy.service.js";

const STRATEGY_SLOTS = [
  "mission",
  "target_markets",
  "icp_buyers",
  "icp_suppliers",
  "brand_voice",
  "pricing_philosophy",
  "no_go_zones",
  "growth_priorities",
  "additional_guidance",
] as const;

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

  /**
   * Sprint S.1 — "Help me write this" drafter. Accepts a slot name +
   * optional hints, returns a Claude-generated draft grounded in the
   * workspace's counterparty + deal evidence. Never persists — the
   * operator accepts the draft client-side via the existing PUT.
   */
  @Post("draft-slot")
  async draftSlot(@Body() raw: unknown) {
    const parsed = DraftSlotSchema.safeParse(raw);
    if (!parsed.success) throw new BadRequestException(parsed.error.message);
    const result = await this.service.draftSlot(
      this.tenant.workspaceId,
      parsed.data.slot,
      parsed.data.hints ?? null,
      // Idempotency key ties the Claude call to this request so a
      // double-click doesn't double-charge the ledger. Fresh ULID per
      // click — reviewer re-generation is an explicit new request.
      createId(),
    );
    if ("error" in result) {
      throw new InternalServerErrorException(result.error);
    }
    return result;
  }
}

const DraftSlotSchema = z
  .object({
    slot: z.enum(STRATEGY_SLOTS),
    hints: z.string().max(1000).optional(),
  })
  .strict();
