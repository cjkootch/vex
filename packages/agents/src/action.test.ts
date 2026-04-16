import { describe, expect, it } from "vitest";
import { ApprovalTier, createId } from "@vex/domain";
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
      organizationId: createId(),
      body: "Had a call, they want pricing",
    });
    expect(actionRequiresApproval(parsed)).toBe(false);
  });

  it("rejects an action whose tier doesn't match its kind", () => {
    expect(() =>
      ActionDescriptor.parse({
        kind: "lead.close",
        tier: ApprovalTier.T1,
        leadId: createId(),
        outcome: "won",
        reason: "—",
      }),
    ).toThrow();
  });

  it("rejects a crm.note with a non-ULID organizationId", () => {
    expect(() =>
      ActionDescriptor.parse({
        kind: "crm.note",
        tier: ApprovalTier.T1,
        organizationId: "not-a-ulid",
        body: "hi",
      }),
    ).toThrow(/ULID/);
  });
});
