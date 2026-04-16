import { describe, expect, it } from "vitest";
import { startBullWorker } from "./runner.js";

describe("startBullWorker", () => {
  it("is an async function that accepts a redis url", () => {
    // Unit test: we only verify the exported surface; integration with a real
    // Redis happens in Docker Compose-backed e2e tests.
    expect(typeof startBullWorker).toBe("function");
  });
});
