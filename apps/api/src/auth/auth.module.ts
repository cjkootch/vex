import { Global, Module, type DynamicModule } from "@nestjs/common";
import { ApiTokenGuard, VEX_API_TOKEN_SECRET } from "./api-token.guard.js";
import { AuthController } from "./auth.controller.js";
import { JwtAuthGuard, NEXTAUTH_SECRET_TOKEN } from "./jwt-auth.guard.js";
import { RolesGuard } from "./roles.guard.js";
import { TenantContext } from "./tenant-context.service.js";

export interface AuthModuleConfig {
  nextAuthSecret: string;
  /**
   * Long-lived bearer for service-to-service ingest endpoints (procur
   * → vex). Null leaves {@link ApiTokenGuard} in a fail-closed state —
   * every protected call returns 401 until the env var is provisioned.
   */
  vexApiToken: string | null;
}

@Global()
@Module({})
export class AuthModule {
  static register(config: AuthModuleConfig): DynamicModule {
    return {
      module: AuthModule,
      global: true,
      controllers: [AuthController],
      providers: [
        { provide: NEXTAUTH_SECRET_TOKEN, useFactory: () => config.nextAuthSecret },
        { provide: VEX_API_TOKEN_SECRET, useFactory: () => config.vexApiToken },
        JwtAuthGuard,
        RolesGuard,
        ApiTokenGuard,
        TenantContext,
      ],
      // Export the secret tokens too — `@UseGuards(JwtAuthGuard)` /
      // `@UseGuards(ApiTokenGuard)` instantiate the guards in the
      // consumer module's context, which needs to see every
      // dependency in its scope.
      exports: [
        NEXTAUTH_SECRET_TOKEN,
        VEX_API_TOKEN_SECRET,
        JwtAuthGuard,
        RolesGuard,
        ApiTokenGuard,
        TenantContext,
      ],
    };
  }
}
