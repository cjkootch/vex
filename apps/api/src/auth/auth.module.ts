import { Global, Module, type DynamicModule } from "@nestjs/common";
import { AuthController } from "./auth.controller.js";
import { JwtAuthGuard, NEXTAUTH_SECRET_TOKEN } from "./jwt-auth.guard.js";
import { RolesGuard } from "./roles.guard.js";
import { TenantContext } from "./tenant-context.service.js";

export interface AuthModuleConfig {
  nextAuthSecret: string;
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
        { provide: NEXTAUTH_SECRET_TOKEN, useValue: config.nextAuthSecret },
        JwtAuthGuard,
        RolesGuard,
        TenantContext,
      ],
      // Export the secret token too — `@UseGuards(JwtAuthGuard)` instantiates
      // the guard in the consumer module's context, which needs to see every
      // dependency in its scope.
      exports: [NEXTAUTH_SECRET_TOKEN, JwtAuthGuard, RolesGuard, TenantContext],
    };
  }
}
