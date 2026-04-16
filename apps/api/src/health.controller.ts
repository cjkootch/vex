import { Controller, Get } from "@nestjs/common";

interface HealthResponse {
  status: "ok";
  service: "vex-api";
  version: string;
}

@Controller("health")
export class HealthController {
  @Get()
  check(): HealthResponse {
    return {
      status: "ok",
      service: "vex-api",
      version: process.env["npm_package_version"] ?? "0.0.0",
    };
  }
}
