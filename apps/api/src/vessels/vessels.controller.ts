import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  NotFoundException,
  Param,
  Post,
  Query,
  UseGuards,
} from "@nestjs/common";
import { z } from "zod";
import {
  withTenant,
  type Db,
  type Vessel,
  type VesselRepository,
} from "@vex/db";
import { JwtAuthGuard, TenantContext } from "../auth/index.js";

/**
 * GET /vessels  — list vessels in the tenant, optional `class` filter,
 *                 limit-capped. Used by the deal-overview VesselPanel
 *                 picker.
 * GET /vessels/:id
 * POST /vessels — create a new vessel inline from the picker's
 *                 "+ New vessel" form.
 */

export const VESSELS_DB_CLIENT = Symbol("VESSELS_DB_CLIENT");
export const VESSELS_REPO = Symbol("VESSELS_REPO");

const VESSEL_CLASSES = [
  "handysize",
  "handymax",
  "panamax",
  "aframax",
  "suezmax",
  "vlcc",
  "mr_tanker",
  "lr1",
  "lr2",
  "coastal",
  "barge",
  "container",
  "reefer",
  "bulk_carrier",
] as const;

const CreateVesselBody = z.object({
  name: z.string().min(1).max(120),
  vesselClass: z.enum(VESSEL_CLASSES),
  imoNumber: z
    .string()
    .regex(/^\d{7}$/, "IMO must be exactly 7 digits")
    .optional(),
  flag: z.string().length(2).optional(),
  dwtMt: z.number().positive().optional(),
  loaM: z.number().positive().optional(),
  beamM: z.number().positive().optional(),
  maxDraftM: z.number().positive().optional(),
  builtYear: z.number().int().min(1900).max(2100).optional(),
  operatorOrgId: z.string().min(1).optional(),
  iceClass: z.string().max(20).optional(),
  doubleHull: z.boolean().optional(),
  notes: z.string().max(2000).optional(),
});

@Controller("vessels")
@UseGuards(JwtAuthGuard)
export class VesselsController {
  constructor(
    @Inject(TenantContext) private readonly tenant: TenantContext,
    @Inject(VESSELS_DB_CLIENT) private readonly db: Db,
    @Inject(VESSELS_REPO) private readonly vessels: VesselRepository,
  ) {}

  @Get()
  async list(
    @Query("class") classRaw?: string,
    @Query("limit") limitRaw?: string,
  ): Promise<{ vessels: Vessel[] }> {
    const vesselClass = (VESSEL_CLASSES as readonly string[]).includes(
      classRaw ?? "",
    )
      ? (classRaw as (typeof VESSEL_CLASSES)[number])
      : undefined;
    const limit = limitRaw ? Math.min(Number.parseInt(limitRaw, 10) || 200, 500) : 200;
    const rows = await withTenant(this.db, this.tenant.tenantId, async (tx) =>
      this.vessels.list(tx, {
        ...(vesselClass ? { vesselClass } : {}),
        limit,
      }),
    );
    return { vessels: rows };
  }

  @Get(":id")
  async detail(@Param("id") id: string): Promise<{ vessel: Vessel }> {
    const vessel = await withTenant(
      this.db,
      this.tenant.tenantId,
      async (tx) => this.vessels.findById(tx, id),
    );
    if (!vessel) throw new NotFoundException(`vessel ${id} not found`);
    return { vessel };
  }

  @Post()
  @HttpCode(201)
  async create(@Body() raw: unknown): Promise<{ vessel: Vessel }> {
    const parsed = CreateVesselBody.safeParse(raw);
    if (!parsed.success) throw new BadRequestException(parsed.error.message);
    const input = parsed.data;
    // Normalise undefined → null for the repo's nullable fields. The
    // Zod parse produces undefined for missing optionals, but
    // VesselCreate types every nullable column as `T | null` so the
    // insert call only ever sees a defined value.
    const create = {
      name: input.name,
      vesselClass: input.vesselClass,
      imoNumber: input.imoNumber ?? null,
      flag: input.flag ?? null,
      dwtMt: input.dwtMt ?? null,
      loaM: input.loaM ?? null,
      beamM: input.beamM ?? null,
      maxDraftM: input.maxDraftM ?? null,
      builtYear: input.builtYear ?? null,
      operatorOrgId: input.operatorOrgId ?? null,
      iceClass: input.iceClass ?? null,
      ...(input.doubleHull !== undefined ? { doubleHull: input.doubleHull } : {}),
      notes: input.notes ?? null,
    };
    const vessel = await withTenant(
      this.db,
      this.tenant.tenantId,
      async (tx) => {
        // De-dupe by IMO when one is supplied — partial unique on
        // (tenant, imo) means a re-submission of the same hull
        // returns the existing row instead of failing.
        if (input.imoNumber) {
          const result = await this.vessels.upsertByImo(
            tx,
            this.tenant.tenantId,
            { ...create, imoNumber: input.imoNumber },
          );
          return result.vessel;
        }
        return this.vessels.create(tx, this.tenant.tenantId, create);
      },
    );
    return { vessel };
  }
}
