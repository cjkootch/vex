import { describe, expect, it } from "vitest";
import { TenantId, UserId } from "./ids.js";

describe("branded ids", () => {
  const validUuid = "3f5b3c4e-2a8d-4f11-8a8b-1a2b3c4d5e6f";

  it("accepts valid uuids", () => {
    expect(TenantId(validUuid)).toBe(validUuid);
    expect(UserId(validUuid)).toBe(validUuid);
  });

  it("rejects non-uuid strings", () => {
    expect(() => TenantId("not-a-uuid")).toThrowError(/TenantId/);
    expect(() => UserId("")).toThrowError(/UserId/);
  });
});
