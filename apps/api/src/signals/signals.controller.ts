import {
  Controller,
  Get,
  Inject,
  NotFoundException,
  Param,
  Post,
  Query,
  UseGuards,
} from "@nestjs/common";
import {
  withTenant,
  type Db,
  type SignalRepository,
} from "@vex/db";
import { JwtAuthGuard, TenantContext } from "../auth/index.js";
import { SIGNALS_DB_CLIENT, SIGNALS_REPO } from "./tokens.js";

export interface SignalResponse {
  id: string;
  ruleId: string;
  severity: string;
  subjectType: string | null;
  subjectId: string | null;
  title: string;
  body: string | null;
  metadata: Record<string, unknown>;
  createdAt: string;
  acknowledgedAt: string | null;
  acknowledgedBy: string | null;
}

@Controller("signals")
@UseGuards(JwtAuthGuard)
export class SignalsController {
  constructor(
    @Inject(TenantContext) private readonly tenant: TenantContext,
    @Inject(SIGNALS_DB_CLIENT) private readonly db: Db,
    @Inject(SIGNALS_REPO) private readonly signals: SignalRepository,
  ) {}

  @Get()
  async list(
    @Query("include") includeRaw?: string,
  ): Promise<{ signals: SignalResponse[] }> {
    const includeAll = includeRaw === "all";
    const rows = await withTenant(this.db, this.tenant.tenantId, async (tx) =>
      includeAll
        ? this.signals.listRecent(tx, 200)
        : this.signals.listOpen(tx, 200),
    );
    return {
      signals: rows.map((r) => ({
        id: r.id,
        ruleId: r.ruleId,
        severity: r.severity,
        subjectType: r.subjectType,
        subjectId: r.subjectId,
        title: r.title,
        body: r.body,
        metadata: (r.metadata ?? {}) as Record<string, unknown>,
        createdAt: r.createdAt.toISOString(),
        acknowledgedAt: r.acknowledgedAt
          ? r.acknowledgedAt.toISOString()
          : null,
        acknowledgedBy: r.acknowledgedBy,
      })),
    };
  }

  @Post(":id/acknowledge")
  async acknowledge(@Param("id") id: string): Promise<SignalResponse> {
    const row = await withTenant(this.db, this.tenant.tenantId, async (tx) =>
      this.signals.acknowledge(tx, id, this.tenant.userId),
    );
    if (!row) throw new NotFoundException();
    return {
      id: row.id,
      ruleId: row.ruleId,
      severity: row.severity,
      subjectType: row.subjectType,
      subjectId: row.subjectId,
      title: row.title,
      body: row.body,
      metadata: (row.metadata ?? {}) as Record<string, unknown>,
      createdAt: row.createdAt.toISOString(),
      acknowledgedAt: row.acknowledgedAt
        ? row.acknowledgedAt.toISOString()
        : null,
      acknowledgedBy: row.acknowledgedBy,
    };
  }
}
