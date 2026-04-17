import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Inject,
  Patch,
  Query,
  UseGuards,
} from "@nestjs/common";
import { z } from "zod";
import { UserRole } from "@vex/domain";
import { JwtAuthGuard, RequireRole, RolesGuard, TenantContext } from "../auth/index.js";
import { AdminService } from "./admin.service.js";

const SettingsPatchSchema = z
  .object({
    enabled_agents: z.array(z.string().min(1)).optional(),
    kill_all_agents: z.boolean().optional(),
    daily_cost_limit: z.number().min(0).max(10_000).optional(),
    source_priority: z.array(z.string().min(1)).optional(),
    feature_rollout: z.record(z.number().min(0).max(100)).optional(),
    sharing_enabled: z.boolean().optional(),
  })
  .strict();

/**
 * OWNER-only admin API. Every route is behind JwtAuthGuard +
 * RolesGuard + @RequireRole(OWNER). Cross-tenant writes are refused
 * inside the service for defense in depth.
 */
@Controller("admin")
@UseGuards(JwtAuthGuard, RolesGuard)
@RequireRole(UserRole.Owner)
export class AdminController {
  constructor(
    @Inject(TenantContext) private readonly tenant: TenantContext,
    @Inject(AdminService) private readonly service: AdminService,
  ) {}

  @Get("settings")
  async getSettings() {
    const settings = await this.service.getSettings(this.tenant.workspaceId);
    return { settings };
  }

  @Patch("settings")
  async updateSettings(@Body() raw: unknown) {
    const parsed = SettingsPatchSchema.safeParse(raw);
    if (!parsed.success) throw new BadRequestException(parsed.error.message);
    const settings = await this.service.updateSettings(
      this.tenant.tenantId,
      this.tenant.workspaceId,
      parsed.data,
      this.tenant.userId,
    );
    return { settings };
  }

  @Get("health")
  async getHealth() {
    return this.service.getHealthMetrics(this.tenant.tenantId);
  }

  @Get("cost-ledger")
  async getCostLedger(
    @Query("from") from?: string,
    @Query("to") to?: string,
    @Query("limit") limit?: string,
  ) {
    const parsedLimit = limit ? Number.parseInt(limit, 10) : undefined;
    return this.service.getCostLedger(
      this.tenant.tenantId,
      from,
      to,
      Number.isFinite(parsedLimit) && parsedLimit! > 0 ? parsedLimit : undefined,
    );
  }

  @Get("evals/latest")
  async getLatestEvals() {
    const results = await this.service.getLatestEvalResults();
    if (!results) {
      return { status: "no_results", message: "No eval run results available yet." };
    }
    return { status: "ok", results };
  }
}
