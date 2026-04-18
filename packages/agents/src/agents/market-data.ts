import type { FuelMarketRateRepository } from "@vex/db";
import type { AgentContext, AgentOutput, IAgent } from "./types.js";

/**
 * Provider-agnostic market data ingestion agent.
 *
 * The data source is injected via `MarketDataProvider`, so EIA, Alpha
 * Vantage, NYMEX, OPIS, or a manual admin feed can all fulfill the same
 * contract. The agent itself handles unit conversion, idempotent upsert,
 * and event emission — what series to pull and where to pull them from is
 * the worker wiring's concern.
 *
 * Tier T1 — writes to `fuel_market_rates` and emits observability events,
 * but never proposes an external-facing action.
 */

export interface MarketDataFetchResult {
  seriesId: string;
  /** YYYY-MM-DD (daily) or week-ending date (weekly). */
  period: string;
  value: number | null;
  unit: string;
}

export interface MarketDataProvider {
  /** Stable identifier stored in `fuel_market_rates.source`. */
  readonly name: string;
  fetchRates(params: {
    seriesId: string;
    start: string;
    end: string;
  }): Promise<MarketDataFetchResult[]>;
}

export interface MarketDataSeries {
  /** Provider-specific series identifier, e.g. `PET.RWTC.D`. */
  seriesId: string;
  /** Canonical product label stored in `fuel_market_rates.product`. */
  product: string;
  /** Canonical benchmark label, e.g. `WTI`, `BRENT`, `USGC`. */
  benchmark: string;
  /** How the provider reports `value`. */
  nativeUnit: "per_gal" | "per_bbl" | "per_mt";
  /**
   * Barrels per metric ton for this product. Defaults to 7.33 (crude
   * oil). Common fuel overrides: gasoline ≈ 8.5, diesel ≈ 7.45,
   * jet-A ≈ 7.88.
   */
  bblPerMt?: number;
}

export interface MarketDataAgentInput {
  provider: MarketDataProvider;
  rates: FuelMarketRateRepository;
  series: MarketDataSeries[];
  /** How many days of history to request each run. Default 7. */
  lookbackDays?: number;
}

export class MarketDataAgent implements IAgent {
  readonly name = "market_data";
  readonly tier = "T1" as const;

  constructor(private readonly input: MarketDataAgentInput) {}

  async run(ctx: AgentContext): Promise<AgentOutput> {
    const lookback = this.input.lookbackDays ?? 7;
    const day = 24 * 60 * 60 * 1000;
    const end = isoDate(new Date());
    const start = isoDate(new Date(Date.now() - lookback * day));

    let rowsIngested = 0;
    const bySeries: Array<{
      seriesId: string;
      rowsReturned: number;
      rowsIngested: number;
    }> = [];

    for (const s of this.input.series) {
      let rowsForSeries = 0;
      let returned = 0;
      try {
        const raw = await this.input.provider.fetchRates({
          seriesId: s.seriesId,
          start,
          end,
        });
        returned = raw.length;
        for (const r of raw) {
          if (r.value === null) continue;
          const { usg, bbl, mt } = convert(r.value, s.nativeUnit, s.bblPerMt ?? 7.33);
          await this.input.rates.upsert(ctx.tx, ctx.tenantId, {
            rateDate: r.period,
            product: s.product,
            benchmark: s.benchmark,
            pricePerUsg: round(usg, 6),
            pricePerBbl: round(bbl, 4),
            pricePerMt: round(mt, 2),
            source: this.input.provider.name,
          });
          rowsForSeries += 1;
        }
      } catch (err) {
        // One provider hiccup shouldn't abort the whole scan. Log via
        // event; the worker's telemetry layer will surface repeated
        // failures.
        await ctx.events.insertIfNotExists(ctx.tx, ctx.tenantId, {
          verb: "agent.market_data.fetch_failed",
          subjectType: "market_series",
          subjectId: s.seriesId,
          actorType: "system",
          actorId: "market_data",
          objectType: "market_series",
          objectId: s.seriesId,
          occurredAt: new Date(),
          idempotencyKey: `market_data.fail:${s.seriesId}:${end}`,
          metadata: {
            provider: this.input.provider.name,
            error: err instanceof Error ? err.message : String(err),
          },
        });
      }

      rowsIngested += rowsForSeries;
      bySeries.push({ seriesId: s.seriesId, rowsReturned: returned, rowsIngested: rowsForSeries });

      await ctx.events.insertIfNotExists(ctx.tx, ctx.tenantId, {
        verb: "agent.market_data.snapshot_ingested",
        subjectType: "market_series",
        subjectId: s.seriesId,
        actorType: "system",
        actorId: "market_data",
        objectType: "market_series",
        objectId: s.seriesId,
        occurredAt: new Date(),
        idempotencyKey: `market_data:${s.seriesId}:${end}`,
        metadata: {
          provider: this.input.provider.name,
          product: s.product,
          benchmark: s.benchmark,
          rows: rowsForSeries,
          window_start: start,
          window_end: end,
        },
      });
    }

    return {
      costUsd: 0,
      outputRefs: {
        provider: this.input.provider.name,
        window_start: start,
        window_end: end,
        rows_ingested: rowsIngested,
        series: bySeries,
      },
      proposedActions: [],
      internalWrites: rowsIngested + bySeries.length,
      rationale:
        rowsIngested === 0
          ? `no new rows from ${this.input.provider.name}`
          : `ingested ${rowsIngested} rows across ${bySeries.length} series from ${this.input.provider.name}`,
    };
  }
}

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function convert(
  value: number,
  nativeUnit: "per_gal" | "per_bbl" | "per_mt",
  bblPerMt: number,
): { usg: number; bbl: number; mt: number } {
  const galPerMt = bblPerMt * 42;
  if (nativeUnit === "per_gal") {
    return { usg: value, bbl: value * 42, mt: value * galPerMt };
  }
  if (nativeUnit === "per_bbl") {
    return { usg: value / 42, bbl: value, mt: value * bblPerMt };
  }
  return { usg: value / galPerMt, bbl: value / bblPerMt, mt: value };
}

function round(n: number, digits: number): number {
  const f = 10 ** digits;
  return Math.round(n * f) / f;
}
