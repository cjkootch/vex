import { Module, type DynamicModule } from "@nestjs/common";
import type { Db } from "@vex/db";
import { SEARCH_DB_CLIENT, SearchController } from "./search.controller.js";

export interface SearchModuleConfig {
  db: Db;
}

@Module({})
export class SearchModule {
  static register(config: SearchModuleConfig): DynamicModule {
    return {
      module: SearchModule,
      controllers: [SearchController],
      providers: [{ provide: SEARCH_DB_CLIENT, useValue: config.db }],
    };
  }
}
