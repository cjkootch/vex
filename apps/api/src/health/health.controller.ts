import { Controller, Get, Inject, UseGuards } from "@nestjs/common";
import { SkipThrottle, Throttle } from "@nestjs/throttler";
import { HealthService } from "./health.service.js";
import { TenantThrottlerGuard } from "../throttler/tenant-throttler.guard.js";

export interface HealthResponse {
  status: "ok";
  service: "vex-api";
  version: string;
}

@Controller("health")
export class HealthController {
  constructor(
    @Inject(HealthService) private readonly health: HealthService,
  ) {}

  /**
   * Unauthenticated lightweight liveness probe. Used by Fly, Vercel, and
   * load balancers — skip throttling so health probes never get 429'd.
   */
  @Get()
  @SkipThrottle()
  check(): HealthResponse {
    return {
      status: "ok",
      service: "vex-api",
      version: process.env["npm_package_version"] ?? "0.0.0",
    };
  }

  /**
   * Detailed dependency report. Unauthenticated (ops tools don't carry
   * NextAuth cookies) but throttled to 10 req/min per IP so a bad actor
   * can't use it to probe dependency topology.
   */
  @Get("detailed")
  @UseGuards(TenantThrottlerGuard)
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  async detailed() {
    return this.health.detailed();
  }
}
