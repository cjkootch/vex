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
import {
  createId,
  type DealStatus,
  type IncotermType,
  type PaymentTermsType,
  type ProductType,
} from "@vex/domain";
import type {
  ApprovalRepository,
  EventRepository,
  FuelDealParticipantRepository,
  FuelDealRepository,
  FuelMarketRateRepository,
  OrganizationRepository,
} from "@vex/db";
import {
  calculateFuelDeal,
  type FuelDealInputs,
  type FuelDealResults,
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
export const DEALS_MARKET_RATE_REPO = Symbol("DEALS_MARKET_RATE_REPO");
export const DEALS_PARTICIPANT_REPO = Symbol("DEALS_PARTICIPANT_REPO");

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

/**
 * A single participant on a deal (supplier, buyer, brokers on either
 * side, intermediaries). `display_name` is always required so an
 * operator can type a broker name before the org exists in the CRM;
 * `orgId` / `contactId` link up when available. Commission variance is
 * captured by a type + value pair — the web client normalises every
 * variant to a per-USG equivalent so the dashboard can feed them into
 * the calculator's intermediary-fee line.
 */
const ParticipantBody = z
  .object({
    partyType: z.enum([
      "supplier",
      "supplier_broker",
      "buyer",
      "buyer_broker",
      "intermediary",
    ]),
    displayName: z.string().min(1).max(200),
    orgId: z.string().min(1).optional(),
    contactId: z.string().min(1).optional(),
    commissionType: z
      .enum(["percentage", "cents_per_liter", "usd_per_mt", "flat_usd", "none"])
      .optional(),
    commissionValue: z.number().min(0).optional(),
    commissionNotes: z.string().max(500).optional(),
    notes: z.string().max(1000).optional(),
  })
  .refine(
    (v) =>
      v.commissionType === undefined ||
      v.commissionType === "none" ||
      v.commissionValue !== undefined,
    {
      message:
        "commissionValue is required when commissionType is not 'none'",
      path: ["commissionValue"],
    },
  );

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
  dealFrequency: z
    .enum(["one_off", "weekly", "biweekly", "monthly", "custom"])
    .optional(),
  dealFrequencyIntervalDays: z.number().int().positive().optional(),
  dealFrequencyNotes: z.string().max(500).optional(),
  participants: z.array(ParticipantBody).max(20).optional(),
})
  .refine(
    (v) =>
      v.dealFrequency !== "custom" ||
      (v.dealFrequencyIntervalDays !== undefined &&
        v.dealFrequencyIntervalDays > 0),
    {
      message:
        "dealFrequencyIntervalDays is required when dealFrequency is 'custom'",
      path: ["dealFrequencyIntervalDays"],
    },
  );

const UpdateStatusBody = z.object({
  status: z.enum(DEAL_STATUSES),
});

/**
 * POST /deals/calculate accepts a superset of deal-create inputs plus the
 * optional economics fields (cost stack, freight overrides, risk scores).
 * Every field is optional — the endpoint fills safe zero-defaults so the
 * calculator can always produce a result while the operator is mid-form.
 * Callers receive back the full FuelDealResults shape plus a list of
 * fields that are still at their default zero so the UI can prompt for
 * the ones that most affect the outcome.
 */
const CalculateDealBody = z
  .object({
    dealRef: z.string().optional(),
    product: z
      .enum([
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
      ])
      .optional(),
    incoterm: z.enum(["fob", "cif", "cfr", "dap", "exw", "fas"]).optional(),
    paymentTerms: z
      .enum([
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
      ])
      .optional(),
    volumeUsg: z.number().positive().optional(),
    densityKgL: z.number().positive().max(2).optional(),
    volumeTolerancePct: z.number().min(0).max(1).optional(),
    sellPricePerUsg: z.number().min(0).optional(),
    buyerCurrencyCode: z.string().length(3).optional(),
    fxRateToUsd: z.number().positive().optional(),
    fxHedgeInPlace: z.boolean().optional(),
    productCostPerUsg: z.number().min(0).optional(),
    productQualityPremiumPerUsg: z.number().min(0).optional(),
    freightPerUsg: z.number().min(0).optional(),
    cargoInsurancePct: z.number().min(0).max(0.5).optional(),
    warRiskPremiumPct: z.number().min(0).max(0.5).optional(),
    politicalRiskPremiumPct: z.number().min(0).max(0.5).optional(),
    dischargeHandlingPerUsg: z.number().min(0).optional(),
    compliancePerUsg: z.number().min(0).optional(),
    tradeFinancePerUsg: z.number().min(0).optional(),
    intermediaryFeePerUsg: z.number().min(0).optional(),
    vtcVariableOpsPerUsg: z.number().min(0).optional(),
    counterpartyRiskScore: z.number().min(0).max(100).optional(),
    countryRiskScore: z.number().min(0).max(100).optional(),
    overheadAllocationUsd: z.number().min(0).optional(),
  })
  .passthrough();

export interface CalculateDealResponse {
  results: FuelDealResults;
  /** Zero-defaulted inputs that materially shape the recommendation. */
  missingEconomicsFields: string[];
}

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
  lineOfBusiness: string;
  volumeUnit: string;
  productionLeadTimeWeeks: number | null;
  coldChainRequired: boolean;
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
    @Inject(DEALS_MARKET_RATE_REPO)
    private readonly marketRates: FuelMarketRateRepository,
    @Inject(DEALS_PARTICIPANT_REPO)
    private readonly participants: FuelDealParticipantRepository,
  ) {}

  @Get()
  async list(
    @Query("status") statusRaw?: string,
    @Query("line_of_business") lobRaw?: string,
    @Query("limit") limitRaw?: string,
  ): Promise<{ deals: DealListRow[] }> {
    const status = statusRaw && STATUS_VALUES.has(statusRaw) ? statusRaw : null;
    const lineOfBusiness =
      lobRaw === "fuel" || lobRaw === "food" ? lobRaw : null;
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
          lineOfBusiness: schema.fuelDeals.lineOfBusiness,
          volumeUnit: schema.fuelDeals.volumeUnit,
          productionLeadTimeWeeks: schema.fuelDeals.productionLeadTimeWeeks,
          coldChainRequired: schema.fuelDeals.coldChainRequired,
          createdAt: schema.fuelDeals.createdAt,
          updatedAt: schema.fuelDeals.updatedAt,
        })
        .from(schema.fuelDeals)
        .leftJoin(buyer, eq(schema.fuelDeals.buyerOrgId, buyer.id));
      const clauses = [
        status ? eq(schema.fuelDeals.status, status as DealStatus) : null,
        lineOfBusiness
          ? eq(schema.fuelDeals.lineOfBusiness, lineOfBusiness)
          : null,
      ].filter((c): c is NonNullable<typeof c> => c !== null);
      const filtered =
        clauses.length === 0
          ? base
          : clauses.length === 1
            ? base.where(clauses[0]!)
            : base.where(and(...clauses));
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
          ...(input.dealFrequency
            ? { dealFrequency: input.dealFrequency }
            : {}),
          ...(input.dealFrequencyIntervalDays !== undefined
            ? { dealFrequencyIntervalDays: input.dealFrequencyIntervalDays }
            : {}),
          ...(input.dealFrequencyNotes
            ? { dealFrequencyNotes: input.dealFrequencyNotes }
            : {}),
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

      // Participants — optional at create. Inserted in the same tx so
      // either the deal + all participants land or neither does.
      if (input.participants && input.participants.length > 0) {
        for (const p of input.participants) {
          await this.participants.create(tx, tenantId, {
            dealId: id,
            partyType: p.partyType,
            displayName: p.displayName,
            ...(p.orgId ? { orgId: p.orgId } : {}),
            ...(p.contactId ? { contactId: p.contactId } : {}),
            ...(p.commissionType
              ? { commissionType: p.commissionType }
              : {}),
            ...(p.commissionValue !== undefined
              ? { commissionValue: p.commissionValue }
              : {}),
            ...(p.commissionNotes ? { commissionNotes: p.commissionNotes } : {}),
            ...(p.notes ? { notes: p.notes } : {}),
          });
        }
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

  /**
   * POST /deals/calculate — run the fuel-deal calculator against an
   * ad-hoc input bundle without persisting anything. Powers the live
   * dashboard on the deal creator: the operator enters pricing + cost
   * inputs, the client debounces requests to this endpoint, and the
   * right pane renders score + warnings + KPI tiles. Every input is
   * optional because the deal can be saved before the economics are
   * fully known; missing fields are filled with safe zero defaults.
   */
  @Post("calculate")
  @HttpCode(200)
  async calculate(@Body() raw: unknown): Promise<CalculateDealResponse> {
    const parsed = CalculateDealBody.safeParse(raw ?? {});
    if (!parsed.success) {
      throw new BadRequestException(parsed.error.message);
    }
    const input = parsed.data;
    const inputs = buildCalculatorInputs(input);
    const results = calculateFuelDeal(inputs);
    return {
      results,
      missingEconomicsFields: findMissingEconomicsFields(input),
    };
  }

  /**
   * GET /deals/benchmarks — latest market rate for a (product, benchmark)
   * pair. The deal creator uses this to render a spread chip next to the
   * sell price input (e.g. "sell $2.85 vs Platts USGC ULSD $2.78").
   * Benchmark slug follows the seed convention: `<basis>_<region>_<product>`.
   */
  @Get("benchmarks")
  async benchmarks(
    @Query("product") product?: string,
    @Query("benchmark") benchmark?: string,
  ): Promise<{
    rate: {
      rateDate: string;
      product: string;
      benchmark: string;
      pricePerUsg: number;
      pricePerBbl: number;
      pricePerMt: number;
      currency: string;
      source: string;
    } | null;
  }> {
    if (!product || !benchmark) {
      throw new BadRequestException("product and benchmark query params required");
    }
    const rate = await withTenant(this.db, this.tenant.tenantId, async (tx) =>
      this.marketRates.getLatest(tx, product, benchmark),
    );
    if (!rate) return { rate: null };
    return {
      rate: {
        rateDate:
          typeof rate.rateDate === "string"
            ? rate.rateDate
            : (rate.rateDate as Date).toISOString().slice(0, 10),
        product: rate.product,
        benchmark: rate.benchmark,
        pricePerUsg: rate.pricePerUsg,
        pricePerBbl: rate.pricePerBbl,
        pricePerMt: rate.pricePerMt,
        currency: rate.currency,
        source: rate.source,
      },
    };
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

  /**
   * GET /deals/:id/participants — list every supplier / buyer / broker
   * / intermediary attached to a deal along with their commission
   * structure. Powers the deal-detail page's "Participants" tab and
   * the deal-creator's on-save confirmation.
   */
  @Get(":id/participants")
  async listParticipants(@Param("id") id: string): Promise<{
    participants: Array<{
      id: string;
      partyType: string;
      displayName: string;
      orgId: string | null;
      contactId: string | null;
      commissionType: string;
      commissionValue: number | null;
      commissionNotes: string | null;
      notes: string | null;
      createdAt: string;
    }>;
  }> {
    const rows = await withTenant(this.db, this.tenant.tenantId, async (tx) => {
      return this.participants.listByDeal(tx, id);
    });
    return {
      participants: rows.map((r) => ({
        id: r.id,
        partyType: r.partyType,
        displayName: r.displayName,
        orgId: r.orgId,
        contactId: r.contactId,
        commissionType: r.commissionType,
        commissionValue: r.commissionValue,
        commissionNotes: r.commissionNotes,
        notes: r.notes,
        createdAt: r.createdAt.toISOString(),
      })),
    };
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

/**
 * Default thresholds mirror the DealEvaluatorAgent constants — every
 * warning triggered in the creator dashboard uses the same cutoffs the
 * async evaluator will use later, so there's no "passed on the form,
 * failed after save" surprise.
 */
const DEFAULT_CALCULATOR_THRESHOLDS = {
  maxPeakCashExposureUsd: 5_000_000,
  minGrossMarginPct: 0.05,
  minNetMarginPerUsg: 0.03,
  maxCounterpartyRiskScore: 65,
  maxCountryRiskScore: 70,
  maxDemurrageDays: 2,
} as const;

const DEFAULT_CALCULATOR_MONTHLY_OVERHEAD_USD = 120_000;

function buildCalculatorInputs(
  input: z.infer<typeof CalculateDealBody>,
): FuelDealInputs {
  return {
    dealRef: input.dealRef ?? "draft",
    product: (input.product ?? "ulsd") as ProductType,
    incoterm: (input.incoterm ?? "cfr") as IncotermType,
    volumeUsg: input.volumeUsg ?? 0,
    densityKgL: input.densityKgL ?? 0.84,
    volumeTolerancePct: input.volumeTolerancePct ?? 0,
    sellPricePerUsg: input.sellPricePerUsg ?? 0,
    buyerCurrencyCode: input.buyerCurrencyCode ?? "usd",
    fxRateToUsd: input.fxRateToUsd ?? 1,
    ...(input.fxHedgeInPlace !== undefined
      ? { fxHedgeInPlace: input.fxHedgeInPlace }
      : {}),
    productCostPerUsg: input.productCostPerUsg ?? 0,
    productQualityPremiumPerUsg: input.productQualityPremiumPerUsg ?? 0,
    freightPerUsg: input.freightPerUsg ?? 0,
    cargoInsurancePct: input.cargoInsurancePct ?? 0,
    warRiskPremiumPct: input.warRiskPremiumPct ?? 0,
    politicalRiskPremiumPct: input.politicalRiskPremiumPct ?? 0,
    dischargeHandlingPerUsg: input.dischargeHandlingPerUsg ?? 0,
    compliancePerUsg: input.compliancePerUsg ?? 0,
    tradeFinancePerUsg: input.tradeFinancePerUsg ?? 0,
    intermediaryFeePerUsg: input.intermediaryFeePerUsg ?? 0,
    vtcVariableOpsPerUsg: input.vtcVariableOpsPerUsg ?? 0,
    overheadAllocationUsd: input.overheadAllocationUsd ?? 0,
    tradeFinance: {
      type: (input.paymentTerms ?? "open_account") as PaymentTermsType,
    },
    counterpartyRiskScore: input.counterpartyRiskScore ?? 40,
    countryRiskScore: input.countryRiskScore ?? 40,
    thresholds: { ...DEFAULT_CALCULATOR_THRESHOLDS },
    monthlyFixedOverheadUsd: DEFAULT_CALCULATOR_MONTHLY_OVERHEAD_USD,
  };
}

/**
 * Economics fields that materially shape the recommendation. When any of
 * these are zero/unset, the calculator still runs but the output is not
 * really actionable — the UI surfaces these so the operator knows what
 * to fill in next.
 */
function findMissingEconomicsFields(
  input: z.infer<typeof CalculateDealBody>,
): string[] {
  const missing: string[] = [];
  if (!input.sellPricePerUsg || input.sellPricePerUsg <= 0)
    missing.push("sellPricePerUsg");
  if (!input.productCostPerUsg || input.productCostPerUsg <= 0)
    missing.push("productCostPerUsg");
  if (!input.volumeUsg || input.volumeUsg <= 0) missing.push("volumeUsg");
  if (input.freightPerUsg === undefined) missing.push("freightPerUsg");
  return missing;
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
  lineOfBusiness?: string | null;
  volumeUnit?: string | null;
  productionLeadTimeWeeks?: number | null;
  coldChainRequired?: boolean | null;
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
    lineOfBusiness: row.lineOfBusiness ?? "fuel",
    volumeUnit: row.volumeUnit ?? "usg",
    productionLeadTimeWeeks: row.productionLeadTimeWeeks ?? null,
    coldChainRequired: row.coldChainRequired ?? false,
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
      lineOfBusiness: schema.fuelDeals.lineOfBusiness,
      volumeUnit: schema.fuelDeals.volumeUnit,
      productionLeadTimeWeeks: schema.fuelDeals.productionLeadTimeWeeks,
      coldChainRequired: schema.fuelDeals.coldChainRequired,
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
    lineOfBusiness: row.lineOfBusiness ?? "fuel",
    volumeUnit: row.volumeUnit ?? "usg",
    productionLeadTimeWeeks: row.productionLeadTimeWeeks ?? null,
    coldChainRequired: row.coldChainRequired ?? false,
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
