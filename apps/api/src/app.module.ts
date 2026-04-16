import { Module, type DynamicModule } from "@nestjs/common";
import { AuthModule } from "./auth/index.js";
import { HealthController } from "./health.controller.js";
import { OrganizationsController } from "./organizations/organizations.controller.js";
import { WebhooksModule } from "./webhooks/webhooks.module.js";

export interface AppModuleConfig {
  webhooks: DynamicModule;
  nextAuthSecret: string;
}

@Module({})
export class AppModule {
  static register(config: AppModuleConfig): DynamicModule {
    return {
      module: AppModule,
      imports: [AuthModule.register({ nextAuthSecret: config.nextAuthSecret }), config.webhooks],
      controllers: [HealthController, OrganizationsController],
    };
  }
}

export { WebhooksModule };
