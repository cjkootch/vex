import { Module, type DynamicModule } from "@nestjs/common";
import type { Db, FuelMarketRateRepository } from "@vex/db";
import {
  MARKET_DB_CLIENT,
  MARKET_RATES_REPO,
  MarketController,
} from "./market.controller.js";

export interface MarketModuleConfig {
  db: Db;
  rates: FuelMarketRateRepository;
}

/**
 * Dynamic module for /market. Exposes read endpoints the MarketIntelPanel
 * consumes — latest snapshots + per-product time series + recent alert
 * crossings. Writes (ingest + alert generation) happen in the worker;
 * the API is read-only.
 */
@Module({})
export class MarketModule {
  static register(config: MarketModuleConfig): DynamicModule {
    return {
      module: MarketModule,
      controllers: [MarketController],
      providers: [
        { provide: MARKET_DB_CLIENT, useValue: config.db },
        { provide: MARKET_RATES_REPO, useValue: config.rates },
      ],
    };
  }
}
