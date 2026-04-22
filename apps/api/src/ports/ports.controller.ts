import {
  Controller,
  Get,
  Inject,
  NotFoundException,
  Param,
  Query,
  UseGuards,
} from "@nestjs/common";
import {
  withTenant,
  type Db,
  type Port,
  type PortEvent,
  type PortRepository,
} from "@vex/db";
import { JwtAuthGuard, TenantContext } from "../auth/index.js";

/**
 * GET /ports                  — list ports (optional region filter).
 * GET /ports/:ref             — single-port detail by UN/LOCODE, ULID,
 *                                or fuzzy name. Includes active events.
 *
 * Powers the chat-driven `port_detail` panel + any future port picker
 * UI. Admin-only port CRUD stays under /admin/ports.
 */

export const PORTS_DB_CLIENT = Symbol("PORTS_DB_CLIENT");
export const PORTS_REPO = Symbol("PORTS_REPO");

export interface PortDetailResponse {
  port: Port;
  activeEvents: PortEvent[];
}

@Controller("ports")
@UseGuards(JwtAuthGuard)
export class PortsController {
  constructor(
    @Inject(TenantContext) private readonly tenant: TenantContext,
    @Inject(PORTS_DB_CLIENT) private readonly db: Db,
    @Inject(PORTS_REPO) private readonly ports: PortRepository,
  ) {}

  @Get()
  async list(
    @Query("region") regionRaw?: string,
    @Query("limit") limitRaw?: string,
  ): Promise<{ ports: Port[] }> {
    const limit = limitRaw
      ? Math.min(Number.parseInt(limitRaw, 10) || 200, 500)
      : 200;
    const region = regionRaw && regionRaw.length > 0 ? regionRaw : null;
    const rows = await withTenant(this.db, this.tenant.tenantId, async (tx) =>
      region
        ? this.ports.listByRegion(tx, region, limit)
        : this.ports.listAll(tx, limit),
    );
    return { ports: rows };
  }

  @Get(":ref")
  async detail(@Param("ref") ref: string): Promise<PortDetailResponse> {
    return withTenant(this.db, this.tenant.tenantId, async (tx) => {
      const port = await this.ports.findByRef(tx, ref);
      if (!port) throw new NotFoundException(`port ${ref} not found`);
      const activeEvents = await this.ports.listActiveEvents(tx, port.id);
      return { port, activeEvents };
    });
  }
}
