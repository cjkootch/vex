import {
  Controller,
  Get,
  Inject,
  Query,
  UseGuards,
} from "@nestjs/common";
import { and, desc, eq, gte } from "drizzle-orm";
import type { FuelMarketRateRepository } from "@vex/db";
import { schema, withTenant, type Db } from "@vex/db";
import { JwtAuthGuard, TenantContext } from "../auth/index.js";

/**
 * GET /market/rates
 *   Latest market rates for the current tenant. When `product` is
 *   supplied as a query parameter, returns the time series for that
 *   product across all benchmarks since `since` (defaults to 30 days);
 *   otherwise returns one row per (product, benchmark) latest snapshot
 *   — the shape the MarketIntelPanel dashboard tile consumes.
 *
 * GET /market/alerts
 *   Recent market-alert crossings from the audit log. Surfaces the
 *   events the MarketAlertAgent emits, decorated with metadata so the
 *   UI can render "WTI up 6.2% vs 30d baseline" rows without a second
 *   round trip.
 *
 * Both endpoints run inside `withTenant` so RLS isolates the query.
 */

export const MARKET_DB_CLIENT = Symbol("MARKET_DB_CLIENT");
export const MARKET_RATES_REPO = Symbol("MARKET_RATES_REPO");

export interface MarketRateRow {
  id: string;
  rateDate: string;
  product: string;
  benchmark: string;
  pricePerUsg: number;
  pricePerBbl: number;
  pricePerMt: number;
  currency: string;
  source: string;
  createdAt: string;
}

export interface MarketAlertRow {
  id: string;
  product: string;
  benchmark: string;
  direction: "up" | "down";
  changePct: number;
  currentPriceUsg: number;
  baselinePriceUsg: number;
  baselineDays: number;
  thresholdPct: number;
  occurredAt: string;
}

const DEFAULT_ALERT_LOOKBACK_DAYS = 14;
const DEFAULT_RATES_LOOKBACK_DAYS = 30;

@Controller("market")
@UseGuards(JwtAuthGuard)
export class MarketController {
  constructor(
    @Inject(TenantContext) private readonly tenant: TenantContext,
    @Inject(MARKET_DB_CLIENT) private readonly db: Db,
    @Inject(MARKET_RATES_REPO) private readonly rates: FuelMarketRateRepository,
  ) {}

  @Get("rates")
  async listRates(
    @Query("product") product?: string,
    @Query("since") sinceRaw?: string,
    @Query("limit") limitRaw?: string,
  ): Promise<{ rates: MarketRateRow[] }> {
    const limit = clampLimit(limitRaw, 100, 500);
    const sinceDate = parseSinceDate(sinceRaw, DEFAULT_RATES_LOOKBACK_DAYS);

    const rows = await withTenant(this.db, this.tenant.tenantId, async (tx) => {
      if (product && product.length > 0) {
        return this.rates.listSince(tx, product, sinceDate, limit);
      }
      return this.rates.listLatestPerSeries(tx, limit);
    });

    return { rates: rows.map(toRateRow) };
  }

  @Get("alerts")
  async listAlerts(
    @Query("since") sinceRaw?: string,
    @Query("limit") limitRaw?: string,
  ): Promise<{ alerts: MarketAlertRow[] }> {
    const limit = clampLimit(limitRaw, 50, 200);
    const sinceDate = parseSinceTimestamp(sinceRaw, DEFAULT_ALERT_LOOKBACK_DAYS);

    const rows = await withTenant(this.db, this.tenant.tenantId, async (tx) => {
      return tx
        .select({
          id: schema.events.id,
          subjectId: schema.events.subjectId,
          occurredAt: schema.events.occurredAt,
          metadata: schema.events.metadata,
        })
        .from(schema.events)
        .where(
          and(
            eq(schema.events.verb, "agent.market_alert.crossing_detected"),
            gte(schema.events.occurredAt, sinceDate),
          ),
        )
        .orderBy(desc(schema.events.occurredAt))
        .limit(limit);
    });

    return { alerts: rows.map(toAlertRow).filter((row): row is MarketAlertRow => row !== null) };
  }
}

function toRateRow(row: {
  id: string;
  rateDate: string;
  product: string;
  benchmark: string;
  pricePerUsg: number;
  pricePerBbl: number;
  pricePerMt: number;
  currency: string;
  source: string;
  createdAt: Date;
}): MarketRateRow {
  return {
    id: row.id,
    rateDate: row.rateDate,
    product: row.product,
    benchmark: row.benchmark,
    pricePerUsg: row.pricePerUsg,
    pricePerBbl: row.pricePerBbl,
    pricePerMt: row.pricePerMt,
    currency: row.currency,
    source: row.source,
    createdAt: row.createdAt.toISOString(),
  };
}

function toAlertRow(row: {
  id: string;
  subjectId: string;
  occurredAt: Date;
  metadata: Record<string, unknown>;
}): MarketAlertRow | null {
  const [product, benchmark] = row.subjectId.split(":");
  if (!product || !benchmark) return null;
  const meta = row.metadata;
  const changePct = numberOr(meta["change_pct"], 0);
  const direction = meta["direction"] === "up" || meta["direction"] === "down"
    ? (meta["direction"] as "up" | "down")
    : changePct >= 0 ? "up" : "down";
  return {
    id: row.id,
    product,
    benchmark,
    direction,
    changePct,
    currentPriceUsg: numberOr(meta["current_price_usg"], 0),
    baselinePriceUsg: numberOr(meta["baseline_price_usg"], 0),
    baselineDays: numberOr(meta["baseline_days"], 30),
    thresholdPct: numberOr(meta["threshold_pct"], 5),
    occurredAt: row.occurredAt.toISOString(),
  };
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function clampLimit(raw: string | undefined, fallback: number, max: number): number {
  const parsed = raw ? Number.parseInt(raw, 10) : fallback;
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.min(parsed, max);
}

function parseSinceTimestamp(raw: string | undefined, defaultDays: number): Date {
  if (raw) {
    const parsed = new Date(raw);
    if (!Number.isNaN(parsed.getTime())) return parsed;
  }
  return new Date(Date.now() - defaultDays * 24 * 60 * 60 * 1000);
}

/** Returns a yyyy-mm-dd string — Drizzle `date` columns compare as text. */
function parseSinceDate(raw: string | undefined, defaultDays: number): string {
  if (raw) {
    const parsed = new Date(raw);
    if (!Number.isNaN(parsed.getTime())) return parsed.toISOString().slice(0, 10);
  }
  const d = new Date(Date.now() - defaultDays * 24 * 60 * 60 * 1000);
  return d.toISOString().slice(0, 10);
}
