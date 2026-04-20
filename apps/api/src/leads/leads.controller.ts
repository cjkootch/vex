import { Controller, Get, Inject, Query, UseGuards } from "@nestjs/common";
import { JwtAuthGuard, TenantContext } from "../auth/index.js";
import { LeadsService } from "./leads.service.js";

@Controller("leads")
@UseGuards(JwtAuthGuard)
export class LeadsController {
  constructor(
    @Inject(TenantContext) private readonly tenant: TenantContext,
    @Inject(LeadsService) private readonly service: LeadsService,
  ) {}

  /**
   * GET /leads/hot?days=7&limit=10
   *
   * Returns leads that tripped the hot signal (intent_to_buy OR
   * urgency=immediate) within the window. Deduped by lead_id —
   * even if multiple qualification runs emitted the signal for the
   * same lead, it appears once with the freshest event's metadata.
   */
  @Get("hot")
  async listHot(
    @Query("days") days: string | undefined,
    @Query("limit") limit: string | undefined,
  ) {
    const parsedDays = clampNumber(days, { min: 1, max: 90, def: 7 });
    const parsedLimit = clampNumber(limit, { min: 1, max: 50, def: 10 });
    const since = new Date(Date.now() - parsedDays * 24 * 60 * 60 * 1000);
    const hot = await this.service.listHotLeads(
      this.tenant.tenantId,
      since,
      parsedLimit,
    );
    return { hot, window_days: parsedDays };
  }
}

function clampNumber(
  raw: string | undefined,
  { min, max, def }: { min: number; max: number; def: number },
): number {
  if (raw === undefined) return def;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n)) return def;
  return Math.max(min, Math.min(max, n));
}
