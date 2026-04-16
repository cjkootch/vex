import { describe, expect, it } from "vitest";
import { ApprovalTier, requiresApproval } from "./approval.js";

describe("requiresApproval", () => {
  it("passes T0 and T1 without approval", () => {
    expect(requiresApproval(ApprovalTier.T0)).toBe(false);
    expect(requiresApproval(ApprovalTier.T1)).toBe(false);
  });

  it("requires approval for T2 and T3", () => {
    expect(requiresApproval(ApprovalTier.T2)).toBe(true);
    expect(requiresApproval(ApprovalTier.T3)).toBe(true);
  });
});
