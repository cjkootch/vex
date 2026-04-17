import { Controller, Get, Inject, NotFoundException, Param, Query, UseGuards } from "@nestjs/common";
import { and, desc, eq, sql } from "drizzle-orm";
import type { DealStatus } from "@vex/domain";
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
  constructor(
    @Inject(TenantContext) private readonly tenant: TenantContext,
    @Inject(DEALS_DB_CLIENT) private readonly db: Db,
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
