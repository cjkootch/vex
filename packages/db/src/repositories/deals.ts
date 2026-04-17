import { and, desc, eq, gte, inArray, lte } from "drizzle-orm";
import { createId } from "@vex/domain";
import type {
  CounterpartyRiskTier,
  DealStatus,
  OfacScreeningStatus,
  PaymentTermsType,
} from "@vex/domain";
import type { Tx } from "../client.js";
import type { FuelDealResults } from "../deals/calculator.js";
import {
  fuelDealCounterpartyScores,
  type FuelDealCounterpartyScore,
} from "../schema/fuel-deal-counterparty-scores.js";
import {
  fuelDealScenarios,
  type FuelDealScenario,
} from "../schema/fuel-deal-scenarios.js";
import { fuelDeals, type FuelDeal, type NewFuelDeal } from "../schema/fuel-deals.js";
import {
  fuelMarketRates,
  type FuelMarketRate,
} from "../schema/fuel-market-rates.js";

/**
 * Fuel deal repositories.
 *
 * All reads go through a `Tx` opened by {@link withTenant} in
 * `@vex/db` — that sets `app.tenant_id` so RLS scopes every query. Inserts
 * and upserts take an explicit `tenantId` because each table's
 * `WITH CHECK` policy requires the column to match the session setting.
 *
 * The repositories here are stateless by design; the existing codebase
 * pattern (`LeadRepository`, `OrganizationRepository`, etc.) uses the same
 * shape so `AgentRunner` can wire them in a single call site.
 *
 * Scope of this file: four repositories covering deals, scenarios,
 * counterparty risk, and market rates. Cost-stack and cashflow-event
 * repositories are intentionally out of scope in this change set.
 */

// ===========================================================================
// FuelDealRepository
// ===========================================================================

/**
 * Create-time payload for a fuel deal. Required fields mirror the
 * `NOT NULL` columns on `fuel_deals` that have no default; everything
 * else is optional and falls through to the schema default.
 */
export interface FuelDealCreate {
  dealRef: string;
  product: NewFuelDeal["product"];
  incoterm: NewFuelDeal["incoterm"];
  pricingBasis: NewFuelDeal["pricingBasis"];
  volumeUsg: number;
  densityKgL: number;
  paymentTerms: PaymentTermsType;
  buyerOrgId: string;
  status?: DealStatus;
  dealType?: NewFuelDeal["dealType"];
  productGrade?: string | null;
  productSpecNotes?: string | null;
  originCountry?: string | null;
  originPort?: string | null;
  originTerminal?: string | null;
  destinationCountry?: string | null;
  destinationPort?: string | null;
  destinationTerminal?: string | null;
  pricingFormula?: string | null;
  priceLockDate?: string | null;
  priceLockTime?: string | null;
  volumeMt?: number | null;
  volumeBbls?: number | null;
  volumeTolerancePct?: number;
  currency?: NewFuelDeal["currency"];
  fxRateToUsd?: number;
  fxHedgeInPlace?: boolean;
  fxHedgeRate?: number | null;
  fxHedgeInstrument?: string | null;
  fxHedgeExpiry?: string | null;
  buyerContactId?: string | null;
  sellerOrgId?: string | null;
  intermediaryOrgId?: string | null;
  intermediaryRole?: string | null;
  leadId?: string | null;
  campaignId?: string | null;
  laycanStart?: string | null;
  laycanEnd?: string | null;
  blDateEstimated?: string | null;
  blDateActual?: string | null;
  etaDestination?: string | null;
  etaActual?: string | null;
  lcIssuingBank?: string | null;
  lcConfirmingBank?: string | null;
  lcValueUsd?: number | null;
  lcExpiryDate?: string | null;
  lcMarginPct?: number | null;
  sblcValueUsd?: number | null;
  tradeFinanceCostPct?: number;
  ofacScreeningStatus?: OfacScreeningStatus;
  bisLicenseRequired?: boolean;
  bisLicenseNumber?: string | null;
  bisLicenseExpiry?: string | null;
  eeiFilingRequired?: boolean;
  eeiItn?: string | null;
  complianceHold?: boolean;
  complianceNotes?: string | null;
  counterpartyRiskScore?: number | null;
  countryRiskScore?: number | null;
  politicalRiskInsured?: boolean;
  notes?: string | null;
  internalNotes?: string | null;
  createdBy?: string | null;
  approvedBy?: string | null;
  /** Explicit id — used by seed code so eval fixtures can reference it. */
  id?: string;
}

export class FuelDealRepository {
  async create(tx: Tx, tenantId: string, data: FuelDealCreate): Promise<FuelDeal> {
    const [row] = await tx
      .insert(fuelDeals)
      .values({
        id: data.id ?? createId(),
        tenantId,
        dealRef: data.dealRef,
        status: data.status ?? "draft",
        dealType: data.dealType ?? "spot",
        product: data.product,
        productGrade: data.productGrade ?? null,
        productSpecNotes: data.productSpecNotes ?? null,
        originCountry: data.originCountry ?? null,
        originPort: data.originPort ?? null,
        originTerminal: data.originTerminal ?? null,
        destinationCountry: data.destinationCountry ?? null,
        destinationPort: data.destinationPort ?? null,
        destinationTerminal: data.destinationTerminal ?? null,
        incoterm: data.incoterm,
        pricingBasis: data.pricingBasis,
        pricingFormula: data.pricingFormula ?? null,
        priceLockDate: data.priceLockDate ?? null,
        priceLockTime: data.priceLockTime ?? null,
        volumeUsg: data.volumeUsg,
        volumeMt: data.volumeMt ?? null,
        volumeBbls: data.volumeBbls ?? null,
        densityKgL: data.densityKgL,
        volumeTolerancePct: data.volumeTolerancePct ?? 0,
        currency: data.currency ?? "usd",
        fxRateToUsd: data.fxRateToUsd ?? 1,
        fxHedgeInPlace: data.fxHedgeInPlace ?? false,
        fxHedgeRate: data.fxHedgeRate ?? null,
        fxHedgeInstrument: data.fxHedgeInstrument ?? null,
        fxHedgeExpiry: data.fxHedgeExpiry ?? null,
        buyerOrgId: data.buyerOrgId,
        buyerContactId: data.buyerContactId ?? null,
        sellerOrgId: data.sellerOrgId ?? null,
        intermediaryOrgId: data.intermediaryOrgId ?? null,
        intermediaryRole: data.intermediaryRole ?? null,
        leadId: data.leadId ?? null,
        campaignId: data.campaignId ?? null,
        laycanStart: data.laycanStart ?? null,
        laycanEnd: data.laycanEnd ?? null,
        blDateEstimated: data.blDateEstimated ?? null,
        blDateActual: data.blDateActual ?? null,
        etaDestination: data.etaDestination ?? null,
        etaActual: data.etaActual ?? null,
        paymentTerms: data.paymentTerms,
        lcIssuingBank: data.lcIssuingBank ?? null,
        lcConfirmingBank: data.lcConfirmingBank ?? null,
        lcValueUsd: data.lcValueUsd ?? null,
        lcExpiryDate: data.lcExpiryDate ?? null,
        lcMarginPct: data.lcMarginPct ?? null,
        sblcValueUsd: data.sblcValueUsd ?? null,
        tradeFinanceCostPct: data.tradeFinanceCostPct ?? 0,
        ofacScreeningStatus: data.ofacScreeningStatus ?? "not_started",
        bisLicenseRequired: data.bisLicenseRequired ?? false,
        bisLicenseNumber: data.bisLicenseNumber ?? null,
        bisLicenseExpiry: data.bisLicenseExpiry ?? null,
        eeiFilingRequired: data.eeiFilingRequired ?? false,
        eeiItn: data.eeiItn ?? null,
        complianceHold: data.complianceHold ?? false,
        complianceNotes: data.complianceNotes ?? null,
        counterpartyRiskScore: data.counterpartyRiskScore ?? null,
        countryRiskScore: data.countryRiskScore ?? null,
        politicalRiskInsured: data.politicalRiskInsured ?? false,
        notes: data.notes ?? null,
        internalNotes: data.internalNotes ?? null,
        createdBy: data.createdBy ?? null,
        approvedBy: data.approvedBy ?? null,
      })
      .returning();
    if (!row) throw new Error("fuel_deal insert returned no row");
    return row;
  }

  async findById(tx: Tx, id: string): Promise<FuelDeal | null> {
    const [row] = await tx.select().from(fuelDeals).where(eq(fuelDeals.id, id)).limit(1);
    return row ?? null;
  }

  async findByStatus(tx: Tx, statuses: DealStatus[]): Promise<FuelDeal[]> {
    if (statuses.length === 0) return [];
    return tx
      .select()
      .from(fuelDeals)
      .where(inArray(fuelDeals.status, statuses))
      .orderBy(desc(fuelDeals.createdAt));
  }

  async findByBuyer(tx: Tx, buyerOrgId: string): Promise<FuelDeal[]> {
    return tx
      .select()
      .from(fuelDeals)
      .where(eq(fuelDeals.buyerOrgId, buyerOrgId))
      .orderBy(desc(fuelDeals.createdAt));
  }

  /**
   * Move a deal to a new lifecycle status. When transitioning to
   * `approved`, stamp `approved_by` with the reviewer so the audit chain
   * has the human who made the call.
   */
  async updateStatus(
    tx: Tx,
    id: string,
    status: DealStatus,
    userId: string | null,
  ): Promise<void> {
    const patch: Partial<NewFuelDeal> = {
      status,
      updatedAt: new Date(),
    };
    if (status === "approved" && userId) patch.approvedBy = userId;
    await tx.update(fuelDeals).set(patch).where(eq(fuelDeals.id, id));
  }

  async listRecent(tx: Tx, limit = 50): Promise<FuelDeal[]> {
    return tx
      .select()
      .from(fuelDeals)
      .orderBy(desc(fuelDeals.createdAt))
      .limit(limit);
  }
}

// ===========================================================================
// FuelDealScenarioRepository
// ===========================================================================

export interface FuelDealScenarioCreate {
  scenarioName: string;
  scenarioType?: FuelDealScenario["scenarioType"];
  isActive?: boolean;
  sellPricePerUsg: number;
  volumeUsgOverride?: number | null;
  productCostOverride?: number | null;
  freightOverridePerUsg?: number | null;
  fxRateOverride?: number | null;
  demurrageDaysOverride?: number | null;
  storageDaysOverride?: number | null;
  notes?: string | null;
  /** Explicit id — used by seed so eval fixtures can reference it. */
  id?: string;
}

export class FuelDealScenarioRepository {
  async createScenario(
    tx: Tx,
    tenantId: string,
    dealId: string,
    data: FuelDealScenarioCreate,
  ): Promise<FuelDealScenario> {
    const [row] = await tx
      .insert(fuelDealScenarios)
      .values({
        id: data.id ?? createId(),
        tenantId,
        dealId,
        scenarioName: data.scenarioName,
        scenarioType: data.scenarioType ?? "base",
        isActive: data.isActive ?? false,
        sellPricePerUsg: data.sellPricePerUsg,
        volumeUsgOverride: data.volumeUsgOverride ?? null,
        productCostOverride: data.productCostOverride ?? null,
        freightOverridePerUsg: data.freightOverridePerUsg ?? null,
        fxRateOverride: data.fxRateOverride ?? null,
        demurrageDaysOverride: data.demurrageDaysOverride ?? null,
        storageDaysOverride: data.storageDaysOverride ?? null,
        notes: data.notes ?? null,
      })
      .returning();
    if (!row) throw new Error("fuel_deal_scenarios insert returned no row");
    return row;
  }

  /**
   * Persist calculator output onto a scenario. Idempotent: the evaluator
   * can re-run and call `saveResults` again without creating duplicate
   * rows anywhere downstream — the update only touches `results_json`,
   * `score`, `recommendation`, `calculated_at`, and `updated_at`.
   */
  async saveResults(
    tx: Tx,
    scenarioId: string,
    results: FuelDealResults,
  ): Promise<void> {
    await tx
      .update(fuelDealScenarios)
      .set({
        // The jsonb column is typed as `Record<string, unknown> | null` so
        // we cast through unknown; `FuelDealResults` has JSON-safe shape.
        resultsJson: results as unknown as Record<string, unknown>,
        score: results.scorecard.overallScore,
        recommendation: results.scorecard.recommendation,
        calculatedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(fuelDealScenarios.id, scenarioId));
  }

  async getActiveScenario(tx: Tx, dealId: string): Promise<FuelDealScenario | null> {
    const [row] = await tx
      .select()
      .from(fuelDealScenarios)
      .where(
        and(
          eq(fuelDealScenarios.dealId, dealId),
          eq(fuelDealScenarios.isActive, true),
        ),
      )
      .limit(1);
    return row ?? null;
  }

  async listScenarios(tx: Tx, dealId: string): Promise<FuelDealScenario[]> {
    return tx
      .select()
      .from(fuelDealScenarios)
      .where(eq(fuelDealScenarios.dealId, dealId))
      .orderBy(desc(fuelDealScenarios.createdAt));
  }

  /**
   * Make `scenarioId` the active scenario for its deal. Runs the clear +
   * set in the same transaction so the "exactly one active per deal"
   * invariant holds even if a prior write left stale rows active.
   */
  async setActive(tx: Tx, scenarioId: string): Promise<void> {
    const [target] = await tx
      .select()
      .from(fuelDealScenarios)
      .where(eq(fuelDealScenarios.id, scenarioId))
      .limit(1);
    if (!target) throw new Error(`scenario ${scenarioId} not found`);
    await tx
      .update(fuelDealScenarios)
      .set({ isActive: false, updatedAt: new Date() })
      .where(eq(fuelDealScenarios.dealId, target.dealId));
    await tx
      .update(fuelDealScenarios)
      .set({ isActive: true, updatedAt: new Date() })
      .where(eq(fuelDealScenarios.id, scenarioId));
  }
}

// ===========================================================================
// CounterpartyRiskRepository
// ===========================================================================

export interface CounterpartyScoreUpsert {
  orgId: string;
  countryRisk: number;
  paymentHistoryRisk: number;
  creditRisk: number;
  sanctionsExposureRisk: number;
  ownershipTransparencyRisk: number;
  regulatoryComplexityRisk: number;
  operationalRisk: number;
  concentrationRisk: number;
  compositeScore: number;
  riskTier: CounterpartyRiskTier;
  recommendedPaymentTerms?: string | null;
  recommendedMaxExposureUsd?: number | null;
  scoredBy?: string | null;
  notes?: string | null;
  /** Explicit id — used by seed. */
  id?: string;
}

export class CounterpartyRiskRepository {
  /** Latest score for an org. `null` when the org has never been scored. */
  async score(tx: Tx, orgId: string): Promise<FuelDealCounterpartyScore | null> {
    const [row] = await tx
      .select()
      .from(fuelDealCounterpartyScores)
      .where(eq(fuelDealCounterpartyScores.orgId, orgId))
      .orderBy(desc(fuelDealCounterpartyScores.scoredAt))
      .limit(1);
    return row ?? null;
  }

  /**
   * Append a new score row. Scores are versioned by `scored_at` rather
   * than mutated in place so historical assessments remain visible.
   */
  async upsertScore(
    tx: Tx,
    tenantId: string,
    data: CounterpartyScoreUpsert,
  ): Promise<FuelDealCounterpartyScore> {
    const [row] = await tx
      .insert(fuelDealCounterpartyScores)
      .values({
        id: data.id ?? createId(),
        tenantId,
        orgId: data.orgId,
        scoredBy: data.scoredBy ?? null,
        countryRisk: data.countryRisk,
        paymentHistoryRisk: data.paymentHistoryRisk,
        creditRisk: data.creditRisk,
        sanctionsExposureRisk: data.sanctionsExposureRisk,
        ownershipTransparencyRisk: data.ownershipTransparencyRisk,
        regulatoryComplexityRisk: data.regulatoryComplexityRisk,
        operationalRisk: data.operationalRisk,
        concentrationRisk: data.concentrationRisk,
        compositeScore: data.compositeScore,
        riskTier: data.riskTier,
        recommendedPaymentTerms: data.recommendedPaymentTerms ?? null,
        recommendedMaxExposureUsd: data.recommendedMaxExposureUsd ?? null,
        notes: data.notes ?? null,
      })
      .returning();
    if (!row) throw new Error("fuel_deal_counterparty_scores insert returned no row");
    return row;
  }

  async getRecommendedTerms(tx: Tx, orgId: string): Promise<string | null> {
    const latest = await this.score(tx, orgId);
    return latest?.recommendedPaymentTerms ?? null;
  }
}

// ===========================================================================
// FuelMarketRateRepository
// ===========================================================================

export interface FuelMarketRateInsert {
  rateDate: string;
  product: string;
  benchmark: string;
  pricePerUsg: number;
  pricePerBbl: number;
  pricePerMt: number;
  currency?: string;
  source: string;
  /** Explicit id — used by seed. */
  id?: string;
}

export class FuelMarketRateRepository {
  /** Most recent rate row for a (product, benchmark) pair. */
  async getLatest(
    tx: Tx,
    product: string,
    benchmark: string,
  ): Promise<FuelMarketRate | null> {
    const [row] = await tx
      .select()
      .from(fuelMarketRates)
      .where(
        and(
          eq(fuelMarketRates.product, product),
          eq(fuelMarketRates.benchmark, benchmark),
        ),
      )
      .orderBy(desc(fuelMarketRates.rateDate))
      .limit(1);
    return row ?? null;
  }

  /**
   * Inclusive date range — both `from` and `to` are yyyy-mm-dd strings to
   * match Drizzle's `date` column type. Returns rows in chronological
   * order so time-series consumers don't have to re-sort.
   */
  async getRange(
    tx: Tx,
    product: string,
    benchmark: string,
    from: string,
    to: string,
  ): Promise<FuelMarketRate[]> {
    return tx
      .select()
      .from(fuelMarketRates)
      .where(
        and(
          eq(fuelMarketRates.product, product),
          eq(fuelMarketRates.benchmark, benchmark),
          gte(fuelMarketRates.rateDate, from),
          lte(fuelMarketRates.rateDate, to),
        ),
      )
      .orderBy(fuelMarketRates.rateDate);
  }

  async insert(
    tx: Tx,
    tenantId: string,
    data: FuelMarketRateInsert,
  ): Promise<FuelMarketRate> {
    const [row] = await tx
      .insert(fuelMarketRates)
      .values({
        id: data.id ?? createId(),
        tenantId,
        rateDate: data.rateDate,
        product: data.product,
        benchmark: data.benchmark,
        pricePerUsg: data.pricePerUsg,
        pricePerBbl: data.pricePerBbl,
        pricePerMt: data.pricePerMt,
        currency: data.currency ?? "usd",
        source: data.source,
      })
      .returning();
    if (!row) throw new Error("fuel_market_rates insert returned no row");
    return row;
  }
}
