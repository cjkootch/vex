import {
  Body,
  Controller,
  Get,
  Inject,
  Param,
  Post,
  Query,
  UseGuards,
} from "@nestjs/common";
import { z } from "zod";
import { JwtAuthGuard, TenantContext } from "../auth/index.js";
import { ApprovalsService } from "./approvals.service.js";

const RejectBody = z.object({ reason: z.string().min(1).optional() });

const BulkDecideBody = z.object({
  ids: z.array(z.string().min(1)).min(1).max(50),
  decision: z.enum(["approve", "reject"]),
  reason: z.string().min(1).max(500).optional(),
});

@Controller("approvals")
@UseGuards(JwtAuthGuard)
export class ApprovalsController {
  constructor(
    @Inject(TenantContext) private readonly tenant: TenantContext,
    @Inject(ApprovalsService) private readonly service: ApprovalsService,
  ) {}

  @Get()
  async list(@Query("status") status: string | undefined, @Query("limit") limit: string | undefined) {
    if (status && status !== "pending") {
      // Sprint 6 only ships /pending; richer filters land in Sprint 7.
      return { approvals: [] };
    }
    const approvals = await this.service.listPending({
      tenantId: this.tenant.tenantId,
      limit: limit ? Number(limit) : 20,
    });
    return { approvals };
  }

  /**
   * Approvals auto/approved but not applied after N seconds. Drives
   * the global "stalled approvals" banner in /app so silent pipeline
   * hangs (worker down, workflow stuck) surface in-product rather
   * than requiring a log grep.
   */
  @Get("stalled")
  async stalled(@Query("after_sec") afterSecRaw: string | undefined) {
    const afterSec = afterSecRaw ? Number.parseInt(afterSecRaw, 10) : 60;
    const approvals = await this.service.listStalled({
      tenantId: this.tenant.tenantId,
      staleAfterSec:
        Number.isFinite(afterSec) && afterSec > 0 ? afterSec : 60,
      limit: 20,
    });
    return { approvals };
  }

  @Get(":id")
  async detail(@Param("id") id: string) {
    const approval = await this.service.findById(this.tenant.tenantId, id);
    return { approval };
  }

  /**
   * GET /approvals/:id/outcome — executor outcome for a decided
   * approval. Returns `{ status: "queued"|"applied"|"failed"|"skipped",
   * reason?, appliedObjectId?, appliedAt?, occurredAt? }`. UI polls
   * this after a decide to show whether the side effect landed or
   * the executor bounced (e.g. "missing toNumber" on outbound_call).
   */
  @Get(":id/outcome")
  async outcome(@Param("id") id: string) {
    const result = await this.service.findByIdWithOutcome(
      this.tenant.tenantId,
      id,
    );
    return { outcome: result.outcome };
  }

  @Post(":id/approve")
  async approve(@Param("id") id: string) {
    const approval = await this.service.approve({
      tenantId: this.tenant.tenantId,
      workspaceId: this.tenant.workspaceId,
      approvalId: id,
      reviewerId: this.tenant.userId,
    });
    return { approval };
  }

  @Post("bulk-decide")
  async bulkDecide(@Body() raw: unknown) {
    const body = BulkDecideBody.parse(raw ?? {});
    const result = await this.service.bulkDecide({
      tenantId: this.tenant.tenantId,
      workspaceId: this.tenant.workspaceId,
      reviewerId: this.tenant.userId,
      approvalIds: body.ids,
      decision: body.decision === "approve" ? "approved" : "rejected",
      ...(body.reason ? { reason: body.reason } : {}),
    });
    return result;
  }

  @Post(":id/reject")
  async reject(@Param("id") id: string, @Body() raw: unknown) {
    const body = RejectBody.parse(raw ?? {});
    const approval = await this.service.reject({
      tenantId: this.tenant.tenantId,
      workspaceId: this.tenant.workspaceId,
      approvalId: id,
      reviewerId: this.tenant.userId,
      ...(body.reason ? { reason: body.reason } : {}),
    });
    return { approval };
  }
}
