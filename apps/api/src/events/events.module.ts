import { Module, type DynamicModule } from "@nestjs/common";
import type { Db } from "@vex/db";
import { EVENTS_DB_CLIENT, EventsController } from "./events.controller.js";

export interface EventsModuleConfig {
  db: Db;
}

@Module({})
export class EventsModule {
  static register(config: EventsModuleConfig): DynamicModule {
    return {
      module: EventsModule,
      controllers: [EventsController],
      providers: [{ provide: EVENTS_DB_CLIENT, useValue: config.db }],
    };
  }
}
