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

  it("accepts a touchpoint.log scoped to a contact (T1, no approval)", () => {
    const parsed = ActionDescriptor.parse({
      kind: "touchpoint.log",
      tier: ApprovalTier.T1,
      contactId: createId(),
      channel: "voice.manual",
      note: "Called John about the Trinidad fuel deal, he'll send terms Thursday",
      direction: "outbound",
    });
    expect(parsed.kind).toBe("touchpoint.log");
    expect(actionRequiresApproval(parsed)).toBe(false);
  });

  it("accepts a touchpoint.log scoped to an org + deal without a contact", () => {
    const parsed = ActionDescriptor.parse({
      kind: "touchpoint.log",
      tier: ApprovalTier.T1,
      orgId: createId(),
      dealId: createId(),
      channel: "meeting",
      note: "Met Cibao's ops team, kickoff for Q3 rice program",
    });
    expect(parsed.kind).toBe("touchpoint.log");
  });

  it("rejects a touchpoint.log with a bad channel", () => {
    expect(() =>
      ActionDescriptor.parse({
        kind: "touchpoint.log",
        tier: ApprovalTier.T1,
        contactId: createId(),
        channel: "email.resend",
        note: "hi",
      }),
    ).toThrow();
  });

  it("rejects a touchpoint.log with an empty note", () => {
    expect(() =>
      ActionDescriptor.parse({
        kind: "touchpoint.log",
        tier: ApprovalTier.T1,
        contactId: createId(),
        channel: "voice.manual",
        note: "",
      }),
    ).toThrow();
  });
});
