import { describe, expect, it } from "vitest";
import { ApprovalTier } from "@vex/domain";
import { ActionDescriptor, actionRequiresApproval } from "./action.js";

describe("ActionDescriptor", () => {
  it("accepts a valid email.send action (T2)", () => {
    const parsed = ActionDescriptor.parse({
      kind: "email.send",
      tier: ApprovalTier.T2,
      to: ["buyer@example.com"],
      subject: "Hello",
      body: "Hi there",
    });
    expect(actionRequiresApproval(parsed)).toBe(true);
  });

  it("accepts a T1 CRM note without approval requirement", () => {
    const parsed = ActionDescriptor.parse({
      kind: "crm.note",
      tier: ApprovalTier.T1,
      accountId: "3f5b3c4e-2a8d-4f11-8a8b-1a2b3c4d5e6f",
      body: "Had a call, they want pricing",
    });
    expect(actionRequiresApproval(parsed)).toBe(false);
  });

  it("rejects an action whose tier doesn't match its kind", () => {
    expect(() =>
      ActionDescriptor.parse({
        kind: "opportunity.close",
        tier: ApprovalTier.T1,
        opportunityId: "3f5b3c4e-2a8d-4f11-8a8b-1a2b3c4d5e6f",
        outcome: "won",
        reason: "—",
      }),
    ).toThrow();
  });
});
