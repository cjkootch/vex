import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  ForbiddenException,
  Get,
  HttpCode,
  Inject,
  Logger,
  NotFoundException,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from "@nestjs/common";
import { and, desc, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { createId, type DealStatus } from "@vex/domain";
import type {
  ApprovalRepository,
  EventRepository,
  FuelDealRepository,
  OrganizationRepository,
} from "@vex/db";
import { JwtAuthGuard, TenantContext } from "../auth/index.js";
import { schema, withTenant, type Db, type Tx } from "@vex/db";

/**
 * GET /deals
 *   List fuel deals for the current tenant, optionally filtered by
 *   status, joined to the buyer organization so the list surface can
 *   show a buyer label without a second round trip.
 *
 * GET /deals/:id
 *   Single-row detail. Includes the latest active scenario's result
 *   JSON blob so the detail page can render score / margin / ebitda
 *   without recomputing.
 *
 * Both endpoints run inside `withTenant` so RLS isolates the query.
 */

export const DEALS_DB_CLIENT = Symbol("DEALS_DB_CLIENT");
export const DEALS_REPO = Symbol("DEALS_REPO");
export const DEALS_EVENT_REPO = Symbol("DEALS_EVENT_REPO");
export const DEALS_APPROVAL_REPO = Symbol("DEALS_APPROVAL_REPO");
export const DEALS_ORGS_REPO = Symbol("DEALS_ORGS_REPO");

/**
 * Status transitions that require a T2 approval instead of applying
 * immediately. Promotion to `approved` starts the real-money part of
 * the deal lifecycle (LC issuance, vessel nomination). `cancelled`
 * destroys value. Both need a four-eyes check before they fire.
 */
const APPROVAL_REQUIRED_STATUSES = new Set<DealStatus>(["approved", "cancelled"]);

const DEAL_STATUSES = [
  "draft",
  "negotiating",
  "approved",
  "in_transit",
  "delivered",
  "settled",
  "cancelled",
] as const satisfies readonly DealStatus[];

const RequestStatusChangeBody = z.object({
  status: z.enum(DEAL_STATUSES),
  rationale: z.string().min(1).max(1000),
});

const CreateDealBody = z.object({
  dealRef: z.string().min(1).max(50),
  product: z.enum([
    "ulsd",
    "gasoline_87",
    "gasoline_91",
    "jet_a",
    "jet_a1",
    "avgas",
    "lfo",
    "hfo",
    "lng",
    "lpg",
    "biodiesel_b20",
  ]),
  incoterm: z.enum(["fob", "cif", "cfr", "dap", "exw", "fas"]),
  pricingBasis: z.enum([
    "platts",
    "argus",
    "opis",
    "nymex_wti",
    "nymex_rbob",
    "ice_brent",
    "fixed",
    "negotiated",
  ]),
  paymentTerms: z.enum([
    "prepayment_100",
    "prepayment_80_20",
    "lc_sight",
    "lc_60d",
    "lc_90d",
    "lc_120d",
    "sblc",
    "open_account",
    "telegraphic_transfer",
    "mixed",
  ]),
  volumeUsg: z.number().positive(),
  densityKgL: z.number().positive().max(2),
  buyerOrgId: z.string().min(1),
  sellerOrgId: z.string().optional(),
  productGrade: z.string().optional(),
  originPort: z.string().optional(),
  destinationPort: z.string().optional(),
  laycanStart: z.string().optional(),
  laycanEnd: z.string().optional(),
  notes: z.string().optional(),
  dealType: z.enum(["spot", "program", "tender", "spot_with_option"]).optional(),
});

const UpdateStatusBody = z.object({
  status: z.enum(DEAL_STATUSES),
});

/**
 * Editable fields on a fuel deal. Deliberately omits `dealRef`
 * (immutable) and `status` (owns its own approval-gated endpoint at
 * PATCH /deals/:id/status). Every field is optional so the caller can
 * ship a partial patch; the controller only writes columns that made
 * it into the validated payload.
 */
const UpdateDealBody = z
  .object({
    product: z.enum([
      "ulsd",
      "gasoline_87",
      "gasoline_91",
      "jet_a",
      "jet_a1",
      "avgas",
      "lfo",
      "hfo",
      "lng",
      "lpg",
      "biodiesel_b20",
    ]),
    volumeUsg: z.number().positive(),
    densityKgL: z.number().positive().max(2),
    incoterm: z.enum(["fob", "cif", "cfr", "dap", "exw", "fas"]),
    pricingBasis: z.enum([
      "platts",
      "argus",
      "opis",
      "nymex_wti",
      "nymex_rbob",
      "ice_brent",
      "fixed",
      "negotiated",
    ]),
    paymentTerms: z.enum([
      "prepayment_100",
      "prepayment_80_20",
      "lc_sight",
      "lc_60d",
      "lc_90d",
      "lc_120d",
      "sblc",
      "open_account",
      "telegraphic_transfer",
      "mixed",
    ]),
    destinationPort: z.string().nullable(),
    originPort: z.string().nullable(),
    laycanStart: z.string().nullable(),
    laycanEnd: z.string().nullable(),
    notes: z.string().nullable(),
    buyerOrgId: z.string().min(1),
  })
  .partial();

export interface DealListRow {
  id: string;
  dealRef: string;
  status: string;
  product: string;
  buyerOrgId: string;
  buyerName: string | null;
  volumeUsg: number;
  incoterm: string;
  laycanStart: string | null;
  laycanEnd: string | null;
  complianceHold: boolean;
  ofacStatus: string;
  createdAt: string;
  updatedAt: string;
}

export interface DealDetail extends DealListRow {
  sellerOrgId: string | null;
  sellerName: string | null;
  originPort: string | null;
  destinationPort: string | null;
  paymentTerms: string;
  currency: string;
  notes: string | null;
  latestScenario: {
    id: string;
    scenarioName: string;
    scenarioType: string;
    isActive: boolean;
    score: number | null;
    recommendation: string | null;
    resultsJson: unknown;
  } | null;
}

const STATUS_VALUES = new Set([
  "draft",
  "negotiating",
  "approved",
  "in_transit",
  "delivered",
  "settled",
  "cancelled",
]);

@Controller("deals")
@UseGuards(JwtAuthGuard)
export class DealsController {
  private readonly log = new Logger(DealsController.name);

  constructor(
    @Inject(TenantContext) private readonly tenant: TenantContext,
    @Inject(DEALS_DB_CLIENT) private readonly db: Db,
    @Inject(DEALS_REPO) private readonly deals: FuelDealRepository,
    @Inject(DEALS_EVENT_REPO) private readonly events: EventRepository,
    @Inject(DEALS_APPROVAL_REPO) private readonly approvals: ApprovalRepository,
    @Inject(DEALS_ORGS_REPO) private readonly organizations: OrganizationRepository,
  ) {}

  @Get()
  async list(
    @Query("status") statusRaw?: string,
    @Query("limit") limitRaw?: string,
  ): Promise<{ deals: DealListRow[] }> {
    const status = statusRaw && STATUS_VALUES.has(statusRaw) ? statusRaw : null;
    const limit = clampLimit(limitRaw, 100, 500);

    const deals = await withTenant(this.db, this.tenant.tenantId, async (tx) => {
      const buyer = schema.organizations;
      const base = tx
        .select({
          id: schema.fuelDeals.id,
          dealRef: schema.fuelDeals.dealRef,
          status: schema.fuelDeals.status,
          product: schema.fuelDeals.product,
          buyerOrgId: schema.fuelDeals.buyerOrgId,
          buyerName: buyer.legalName,
          volumeUsg: schema.fuelDeals.volumeUsg,
          incoterm: schema.fuelDeals.incoterm,
          laycanStart: schema.fuelDeals.laycanStart,
          laycanEnd: schema.fuelDeals.laycanEnd,
          complianceHold: schema.fuelDeals.complianceHold,
          ofacStatus: schema.fuelDeals.ofacScreeningStatus,
          createdAt: schema.fuelDeals.createdAt,
          updatedAt: schema.fuelDeals.updatedAt,
        })
        .from(schema.fuelDeals)
        .leftJoin(buyer, eq(schema.fuelDeals.buyerOrgId, buyer.id));
      const filtered = status
        ? base.where(eq(schema.fuelDeals.status, status as DealStatus))
        : base;
      const rows = await filtered
        .orderBy(desc(schema.fuelDeals.createdAt))
        .limit(limit);
      return rows.map(toListRow);
    });

    return { deals };
  }

  @Post()
  @HttpCode(201)
  async create(@Body() raw: unknown): Promise<{ deal: DealDetail }> {
    const parsed = CreateDealBody.safeParse(raw);
    if (!parsed.success) {
      throw new BadRequestException(parsed.error.message);
    }
    const input = parsed.data;
    const id = createId();
    const { tenantId, userId } = this.tenant;

    const deal = await withTenant(this.db, tenantId, async (tx) => {
      // Verify buyer org exists under this tenant — RLS will already
      // filter an impossible id, so an empty result here means the
      // caller passed a bogus id or one from another tenant.
      const [buyer] = await tx
        .select({ id: schema.organizations.id })
        .from(schema.organizations)
        .where(eq(schema.organizations.id, input.buyerOrgId))
        .limit(1);
      if (!buyer) {
        throw new BadRequestException(
          `buyerOrgId ${input.buyerOrgId} does not exist in this workspace`,
        );
      }

      try {
        await this.deals.create(tx, tenantId, {
          id,
          dealRef: input.dealRef,
          product: input.product,
          incoterm: input.incoterm,
          pricingBasis: input.pricingBasis,
          paymentTerms: input.paymentTerms,
          volumeUsg: input.volumeUsg,
          densityKgL: input.densityKgL,
          buyerOrgId: input.buyerOrgId,
          ...(input.sellerOrgId ? { sellerOrgId: input.sellerOrgId } : {}),
          ...(input.productGrade ? { productGrade: input.productGrade } : {}),
          ...(input.originPort ? { originPort: input.originPort } : {}),
          ...(input.destinationPort ? { destinationPort: input.destinationPort } : {}),
          ...(input.laycanStart ? { laycanStart: input.laycanStart } : {}),
          ...(input.laycanEnd ? { laycanEnd: input.laycanEnd } : {}),
          ...(input.notes ? { notes: input.notes } : {}),
          ...(input.dealType ? { dealType: input.dealType } : {}),
          createdBy: userId,
        });
      } catch (err) {
        const message = (err as Error).message;
        if (message.includes("duplicate") || message.includes("unique")) {
          throw new ConflictException(
            `a deal with ref ${input.dealRef} already exists`,
          );
        }
        throw err;
      }

      await this.events.insertIfNotExists(tx, tenantId, {
        verb: "deal.created",
        subjectType: "fuel_deal",
        subjectId: id,
        actorType: "user",
        actorId: userId,
        objectType: "fuel_deal",
        objectId: id,
        occurredAt: new Date(),
        idempotencyKey: `deal.created:${id}`,
        metadata: {
          deal_ref: input.dealRef,
          product: input.product,
          buyer_org_id: input.buyerOrgId,
          volume_usg: input.volumeUsg,
          created_by: userId,
        },
      });

      const detail = await loadDealDetail(tx, id);
      if (!detail) throw new Error(`created deal ${id} not readable`);
      return detail;
    });

    this.log.log(`deal ${input.dealRef} (${id}) created by ${userId}`);
    return { deal };
  }

  @Patch(":id/status")
  async updateStatus(
    @Param("id") id: string,
    @Body() raw: unknown,
  ): Promise<{ deal: DealDetail }> {
    const parsed = UpdateStatusBody.safeParse(raw);
    if (!parsed.success) {
      throw new BadRequestException(parsed.error.message);
    }
    const { status } = parsed.data;
    if (APPROVAL_REQUIRED_STATUSES.has(status)) {
      throw new ForbiddenException(
        `transition to '${status}' requires an approval — POST /deals/${id}/status/request with a rationale`,
      );
    }
    const { tenantId, userId } = this.tenant;

    const deal = await withTenant(this.db, tenantId, async (tx) => {
      const before = await this.deals.findById(tx, id);
      if (!before) throw new NotFoundException(`deal ${id} not found`);
      if (before.status === status) {
        const detail = await loadDealDetail(tx, id);
        if (!detail) throw new Error(`deal ${id} not readable`);
        return detail;
      }

      await this.deals.updateStatus(tx, id, status, userId);

      await this.events.insertIfNotExists(tx, tenantId, {
        verb: "deal.status_changed",
        subjectType: "fuel_deal",
        subjectId: id,
        actorType: "user",
        actorId: userId,
        objectType: "fuel_deal",
        objectId: id,
        occurredAt: new Date(),
        idempotencyKey: `deal.status_changed:${id}:${before.status}->${status}:${Date.now()}`,
        metadata: {
          deal_ref: before.dealRef,
          from_status: before.status,
          to_status: status,
          actor_user_id: userId,
        },
      });

      const detail = await loadDealDetail(tx, id);
      if (!detail) throw new Error(`deal ${id} not readable`);
      return detail;
    });

    this.log.log(`deal ${id} status → ${status} by ${userId}`);
    return { deal };
  }

  @Post(":id/status/request")
  @HttpCode(201)
  async requestStatusChange(
    @Param("id") id: string,
    @Body() raw: unknown,
  ): Promise<{ approvalId: string; status: "pending" }> {
    const parsed = RequestStatusChangeBody.safeParse(raw);
    if (!parsed.success) {
      throw new BadRequestException(parsed.error.message);
    }
    const { status: targetStatus, rationale } = parsed.data;
    const { tenantId, userId } = this.tenant;

    const approvalId = await withTenant(this.db, tenantId, async (tx) => {
      const deal = await this.deals.findById(tx, id);
      if (!deal) throw new NotFoundException(`deal ${id} not found`);
      if (deal.status === targetStatus) {
        throw new BadRequestException(
          `deal is already in status '${targetStatus}'`,
        );
      }

      const approval = await this.approvals.create(tx, tenantId, {
        agentRunId: null,
        actionType: "deal.status_change",
        proposedPayload: {
          tier: "T2",
          deal_id: id,
          deal_ref: deal.dealRef,
          from_status: deal.status,
          to_status: targetStatus,
          rationale,
          requested_by: userId,
        },
      });

      await this.events.insertIfNotExists(tx, tenantId, {
        verb: "deal.status_change_requested",
        subjectType: "fuel_deal",
        subjectId: id,
        actorType: "user",
        actorId: userId,
        objectType: "approval",
        objectId: approval.id,
        occurredAt: new Date(),
        idempotencyKey: `deal.status_change_requested:${approval.id}`,
        metadata: {
          deal_ref: deal.dealRef,
          from_status: deal.status,
          to_status: targetStatus,
          rationale,
        },
      });

      return approval.id;
    });

    this.log.log(
      `deal ${id} status→${targetStatus} approval requested (approval=${approvalId}) by ${userId}`,
    );
    return { approvalId, status: "pending" };
  }

  @Patch(":id")
  async update(
    @Param("id") id: string,
    @Body() raw: unknown,
  ): Promise<{ deal: DealDetail }> {
    const parsed = UpdateDealBody.safeParse(raw);
    if (!parsed.success) {
      throw new BadRequestException(parsed.error.message);
    }
    const patch = parsed.data;
    const { tenantId, userId } = this.tenant;

    const deal = await withTenant(this.db, tenantId, async (tx) => {
      const before = await loadDealDetail(tx, id);
      if (!before) throw new NotFoundException(`deal ${id} not found`);

      // Verify a new buyer (when changed) actually exists in this
      // tenant. RLS already filters the lookup, so an empty result
      // means the caller passed a bogus or cross-tenant id.
      if (patch.buyerOrgId && patch.buyerOrgId !== before.buyerOrgId) {
        const buyer = await this.organizations.findById(tx, patch.buyerOrgId);
        if (!buyer) {
          throw new NotFoundException(
            `buyerOrgId ${patch.buyerOrgId} does not exist in this workspace`,
          );
        }
      }

      // Build a minimal update payload — only write columns that made
      // it through Zod validation so the caller can send a partial
      // patch without clobbering untouched fields.
      const set: Record<string, unknown> = { updatedAt: new Date() };
      if (patch.product !== undefined) set["product"] = patch.product;
      if (patch.volumeUsg !== undefined) set["volumeUsg"] = patch.volumeUsg;
      if (patch.densityKgL !== undefined) set["densityKgL"] = patch.densityKgL;
      if (patch.incoterm !== undefined) set["incoterm"] = patch.incoterm;
      if (patch.pricingBasis !== undefined)
        set["pricingBasis"] = patch.pricingBasis;
      if (patch.paymentTerms !== undefined)
        set["paymentTerms"] = patch.paymentTerms;
      if (patch.destinationPort !== undefined)
        set["destinationPort"] = patch.destinationPort;
      if (patch.originPort !== undefined) set["originPort"] = patch.originPort;
      if (patch.laycanStart !== undefined) set["laycanStart"] = patch.laycanStart;
      if (patch.laycanEnd !== undefined) set["laycanEnd"] = patch.laycanEnd;
      if (patch.notes !== undefined) set["notes"] = patch.notes;
      if (patch.buyerOrgId !== undefined) set["buyerOrgId"] = patch.buyerOrgId;

      await tx
        .update(schema.fuelDeals)
        .set(set)
        .where(eq(schema.fuelDeals.id, id))
        .returning();

      const after = await loadDealDetail(tx, id);
      if (!after) throw new Error(`deal ${id} not readable after update`);

      await this.events.insertIfNotExists(tx, tenantId, {
        verb: "deal.updated",
        subjectType: "fuel_deal",
        subjectId: id,
        actorType: "user",
        actorId: userId,
        objectType: "fuel_deal",
        objectId: id,
        occurredAt: new Date(),
        // Stable key — tied to the pre-patch updatedAt so a retry of
        // the same edit dedupes, but a second distinct edit lands a
        // fresh row.
        idempotencyKey: `deal.updated:${id}:${before.updatedAt}`,
        metadata: {
          patch,
          before,
          after,
          audit_event_id: createId(),
        },
      });

      return after;
    });

    this.log.log(`deal ${id} updated by ${userId}`);
    return { deal };
  }

  @Get(":id")
  async detail(@Param("id") id: string): Promise<{ deal: DealDetail }> {
    const deal = await withTenant(this.db, this.tenant.tenantId, async (tx) => {
      const row = await loadDealDetail(tx, id);
      if (!row) return null;
      return row;
    });
    if (!deal) throw new NotFoundException(`deal ${id} not found`);
    return { deal };
  }

}

function clampLimit(raw: string | undefined, fallback: number, max: number): number {
  const parsed = raw ? Number.parseInt(raw, 10) : fallback;
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.min(parsed, max);
}

function toListRow(row: {
  id: string;
  dealRef: string;
  status: string;
  product: string;
  buyerOrgId: string;
  buyerName: string | null;
  volumeUsg: number;
  incoterm: string;
  laycanStart: string | null;
  laycanEnd: string | null;
  complianceHold: boolean;
  ofacStatus: string;
  createdAt: Date;
  updatedAt: Date;
}): DealListRow {
  return {
    id: row.id,
    dealRef: row.dealRef,
    status: row.status,
    product: row.product,
    buyerOrgId: row.buyerOrgId,
    buyerName: row.buyerName,
    volumeUsg: row.volumeUsg,
    incoterm: row.incoterm,
    laycanStart: row.laycanStart,
    laycanEnd: row.laycanEnd,
    complianceHold: row.complianceHold,
    ofacStatus: row.ofacStatus,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

async function loadDealDetail(tx: Tx, id: string): Promise<DealDetail | null> {
  const buyer = schema.organizations;
  const [row] = await tx
    .select({
      id: schema.fuelDeals.id,
      dealRef: schema.fuelDeals.dealRef,
      status: schema.fuelDeals.status,
      product: schema.fuelDeals.product,
      buyerOrgId: schema.fuelDeals.buyerOrgId,
      buyerName: buyer.legalName,
      volumeUsg: schema.fuelDeals.volumeUsg,
      incoterm: schema.fuelDeals.incoterm,
      laycanStart: schema.fuelDeals.laycanStart,
      laycanEnd: schema.fuelDeals.laycanEnd,
      complianceHold: schema.fuelDeals.complianceHold,
      ofacStatus: schema.fuelDeals.ofacScreeningStatus,
      createdAt: schema.fuelDeals.createdAt,
      updatedAt: schema.fuelDeals.updatedAt,
      sellerOrgId: schema.fuelDeals.sellerOrgId,
      originPort: schema.fuelDeals.originPort,
      destinationPort: schema.fuelDeals.destinationPort,
      paymentTerms: schema.fuelDeals.paymentTerms,
      currency: schema.fuelDeals.currency,
      notes: schema.fuelDeals.notes,
    })
    .from(schema.fuelDeals)
    .leftJoin(buyer, eq(schema.fuelDeals.buyerOrgId, buyer.id))
    .where(eq(schema.fuelDeals.id, id))
    .limit(1);
  if (!row) return null;

  let sellerName: string | null = null;
  if (row.sellerOrgId) {
    const [sellerRow] = await tx
      .select({ legalName: buyer.legalName })
      .from(buyer)
      .where(eq(buyer.id, row.sellerOrgId))
      .limit(1);
    sellerName = sellerRow?.legalName ?? null;
  }

  const [scenario] = await tx
    .select({
      id: schema.fuelDealScenarios.id,
      scenarioName: schema.fuelDealScenarios.scenarioName,
      scenarioType: schema.fuelDealScenarios.scenarioType,
      isActive: schema.fuelDealScenarios.isActive,
      score: schema.fuelDealScenarios.score,
      recommendation: schema.fuelDealScenarios.recommendation,
      resultsJson: schema.fuelDealScenarios.resultsJson,
    })
    .from(schema.fuelDealScenarios)
    .where(
      and(
        eq(schema.fuelDealScenarios.dealId, id),
        sql`${schema.fuelDealScenarios.isActive} = true`,
      ),
    )
    .orderBy(desc(schema.fuelDealScenarios.createdAt))
    .limit(1);

  return {
    id: row.id,
    dealRef: row.dealRef,
    status: row.status,
    product: row.product,
    buyerOrgId: row.buyerOrgId,
    buyerName: row.buyerName,
    volumeUsg: row.volumeUsg,
    incoterm: row.incoterm,
    laycanStart: row.laycanStart,
    laycanEnd: row.laycanEnd,
    complianceHold: row.complianceHold,
    ofacStatus: row.ofacStatus,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    sellerOrgId: row.sellerOrgId,
    sellerName,
    originPort: row.originPort,
    destinationPort: row.destinationPort,
    paymentTerms: row.paymentTerms,
    currency: row.currency,
    notes: row.notes,
    latestScenario: scenario
      ? {
          id: scenario.id,
          scenarioName: scenario.scenarioName,
          scenarioType: scenario.scenarioType,
          isActive: scenario.isActive,
          score: scenario.score,
          recommendation: scenario.recommendation,
          resultsJson: scenario.resultsJson,
        }
      : null,
  };
}
