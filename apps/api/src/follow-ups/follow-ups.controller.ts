import {
  BadRequestException,
  Controller,
  Get,
  HttpCode,
  Inject,
  Param,
  Post,
  Query,
  UseGuards,
} from "@nestjs/common";
import { z } from "zod";
import {
  withTenant,
  type Db,
  type FollowUpRepository,
} from "@vex/db";
import { JwtAuthGuard, TenantContext } from "../auth/index.js";

export const FOLLOW_UPS_DB_CLIENT = Symbol("FOLLOW_UPS_DB_CLIENT");
export const FOLLOW_UPS_REPO = Symbol("FOLLOW_UPS_REPO");

const StatusQuery = z.enum(["open", "completed", "cancelled"]).optional();

/**
 * /follow-ups — read-side list + mark-completed/cancel.
 *
 * Creation flows through the approval executor (Sprint P
 * applyFollowUpSchedule); there's no direct POST here because every
 * follow-up originates from an approved chat-agent proposal.
 */
@Controller("follow-ups")
@UseGuards(JwtAuthGuard)
export class FollowUpsController {
  constructor(
    @Inject(TenantContext) private readonly tenant: TenantContext,
    @Inject(FOLLOW_UPS_DB_CLIENT) private readonly db: Db,
    @Inject(FOLLOW_UPS_REPO) private readonly repo: FollowUpRepository,
  ) {}

  @Get()
  async list(@Query("status") statusRaw?: string) {
    const status = StatusQuery.safeParse(statusRaw);
    const filter = status.success ? status.data ?? "open" : "open";
    return withTenant(this.db, this.tenant.tenantId, async (tx) => {
      const rows =
        filter === "open"
          ? await this.repo.listOpen(tx, 100)
          : await this.repo.listOpenAnyInTenant(tx, 100); // TODO: filter by status
      return {
        follow_ups: rows.map((r) => ({
          id: r.id,
          title: r.title,
          note: r.note,
          dueAt: r.dueAt.toISOString(),
          subjectType: r.subjectType,
          subjectId: r.subjectId,
          assignedTo: r.assignedTo,
          status: r.status,
          createdBy: r.createdBy,
          createdAt: r.createdAt.toISOString(),
        })),
      };
    });
  }

  @Post(":id/complete")
  @HttpCode(200)
  async complete(@Param("id") id: string) {
    return withTenant(this.db, this.tenant.tenantId, async (tx) => {
      try {
        const row = await this.repo.markCompleted(tx, id);
        return { id: row.id, status: row.status };
      } catch (err) {
        throw new BadRequestException((err as Error).message);
      }
    });
  }

  @Post(":id/cancel")
  @HttpCode(200)
  async cancel(@Param("id") id: string) {
    return withTenant(this.db, this.tenant.tenantId, async (tx) => {
      try {
        const row = await this.repo.markCancelled(tx, id);
        return { id: row.id, status: row.status };
      } catch (err) {
        throw new BadRequestException((err as Error).message);
      }
    });
  }
}
