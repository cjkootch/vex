import { describe, expect, it } from "vitest";
import { TenantId, UserId, WorkspaceId, createId, isUlid } from "./ids.js";

describe("createId / isUlid", () => {
  it("generates valid 26-char Crockford base32 ULIDs", () => {
    const id = createId();
    expect(id).toHaveLength(26);
    expect(isUlid(id)).toBe(true);
  });

  it("rejects non-ULID strings", () => {
    expect(isUlid("not-a-ulid")).toBe(false);
    expect(isUlid("3f5b3c4e-2a8d-4f11-8a8b-1a2b3c4d5e6f")).toBe(false);
    expect(isUlid("")).toBe(false);
  });
});

describe("branded ids", () => {
  const validUlid = createId();

  it("accepts valid ULIDs", () => {
    expect(TenantId(validUlid)).toBe(validUlid);
    expect(UserId(validUlid)).toBe(validUlid);
    expect(WorkspaceId(validUlid)).toBe(validUlid);
  });

  it("rejects strings that aren't ULIDs", () => {
    expect(() => TenantId("not-a-ulid")).toThrowError(/TenantId/);
    expect(() => UserId("")).toThrowError(/UserId/);
  });
});
