import { describe, expect, it } from "vitest";
import { HealthController } from "./health.controller.js";

describe("HealthController", () => {
  it("returns ok status", () => {
    const controller = new HealthController();
    const result = controller.check();
    expect(result.status).toBe("ok");
    expect(result.service).toBe("vex-api");
  });
});
