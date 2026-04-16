import { Module, type DynamicModule } from "@nestjs/common";
import { AuthModule } from "./auth/index.js";
import { HealthController } from "./health.controller.js";
import { OrganizationsController } from "./organizations/organizations.controller.js";
import { WebhooksModule } from "./webhooks/webhooks.module.js";
import { QueryModule } from "./query/query.module.js";

export interface AppModuleConfig {
  webhooks: DynamicModule;
  query?: DynamicModule;
  nextAuthSecret: string;
}

@Module({})
export class AppModule {
  static register(config: AppModuleConfig): DynamicModule {
    const imports: DynamicModule[] = [
      AuthModule.register({ nextAuthSecret: config.nextAuthSecret }),
      config.webhooks,
    ];
    if (config.query) imports.push(config.query);
    return {
      module: AppModule,
      imports,
      controllers: [HealthController, OrganizationsController],
    };
  }
}

export { WebhooksModule, QueryModule };
