import { describe, expect, it } from "vitest";
import { isUlid } from "@vex/domain";
import {
  ALL_SEED_IDS,
  SEED_ADMIN_USER_ID,
  SEED_CAMPAIGN_IDS,
  SEED_CONTACT_IDS,
  SEED_ORG_IDS,
  SEED_WORKSPACE_ID,
} from "./seed-ids.js";

describe("seed ids", () => {
  it("every seed id is a valid ULID", () => {
    for (const id of ALL_SEED_IDS) {
      expect(isUlid(id), `${id} is not a valid ULID`).toBe(true);
    }
  });

  it("is a unique set", () => {
    const unique = new Set(ALL_SEED_IDS);
    expect(unique.size).toBe(ALL_SEED_IDS.length);
  });

  it("contains the expected top-level IDs", () => {
    expect(SEED_WORKSPACE_ID).toHaveLength(26);
    expect(SEED_ADMIN_USER_ID).toHaveLength(26);
    // 5 pre-Sprint-11 orgs + 3 Caribbean fuel-deal buyers added in Sprint 11.
    expect(Object.values(SEED_ORG_IDS)).toHaveLength(8);
    expect(SEED_CONTACT_IDS).toHaveLength(20);
    expect(Object.values(SEED_CAMPAIGN_IDS)).toHaveLength(3);
  });
});
