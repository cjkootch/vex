import { Module, type DynamicModule } from "@nestjs/common";
import { HealthController } from "./health.controller.js";
import { WebhooksModule } from "./webhooks/webhooks.module.js";

export interface AppModuleConfig {
  webhooks: DynamicModule;
}

@Module({})
export class AppModule {
  static register(config: AppModuleConfig): DynamicModule {
    return {
      module: AppModule,
      imports: [config.webhooks],
      controllers: [HealthController],
    };
  }
}

/**
 * Re-export for tests that don't need the full AppModule wiring.
 */
export { WebhooksModule };
