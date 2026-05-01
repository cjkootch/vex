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

  it("accepts a lead.reactivate_draft with contacts + product + rationale", () => {
    const parsed = ActionDescriptor.parse({
      kind: "lead.reactivate_draft",
      tier: ApprovalTier.T2,
      contactIds: [createId(), createId(), createId()],
      productContext: "Q3 2026 parboiled rice, Caribbean delivery, LC60D",
      angle: "Open LC60D terms",
      rationale: "Top 3 Caribbean rice buyers, 90+ days stale",
    });
    expect(parsed.kind).toBe("lead.reactivate_draft");
    expect(actionRequiresApproval(parsed)).toBe(true);
  });

  it("rejects a lead.reactivate_draft with 0 contacts", () => {
    expect(() =>
      ActionDescriptor.parse({
        kind: "lead.reactivate_draft",
        tier: ApprovalTier.T2,
        contactIds: [],
        productContext: "rice",
        rationale: "because",
      }),
    ).toThrow();
  });

  it("rejects a lead.reactivate_draft with more than 20 contacts", () => {
    expect(() =>
      ActionDescriptor.parse({
        kind: "lead.reactivate_draft",
        tier: ApprovalTier.T2,
        contactIds: Array.from({ length: 21 }, () => createId()),
        productContext: "rice",
        rationale: "too many",
      }),
    ).toThrow();
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

  it("accepts a valid campaign.create with 3 multi-channel steps", () => {
    const parsed = ActionDescriptor.parse({
      kind: "campaign.create",
      tier: ApprovalTier.T2,
      name: "Haiti food nurture",
      channel: "multi",
      objective: "Warm up Haiti importers on parboiled rice spots",
      steps: [
        {
          position: 0,
          channel: "email",
          delayAfterPriorMs: 0,
          tier: "T2",
          autoApprove: false,
        },
        {
          position: 1,
          channel: "email",
          delayAfterPriorMs: 3 * 86_400_000,
          tier: "T2",
          autoApprove: false,
        },
        {
          position: 2,
          channel: "sms",
          delayAfterPriorMs: 7 * 86_400_000,
          tier: "T2",
          autoApprove: false,
        },
      ],
      rationale: "No existing Haitian-importer cadence; propose a new 3-step multi-channel nurture.",
    });
    expect(parsed.kind).toBe("campaign.create");
    expect(actionRequiresApproval(parsed)).toBe(true);
  });

  it("rejects campaign.create with zero steps", () => {
    expect(() =>
      ActionDescriptor.parse({
        kind: "campaign.create",
        tier: ApprovalTier.T2,
        name: "empty",
        channel: "email",
        steps: [],
        rationale: "x",
      }),
    ).toThrow();
  });

  it("rejects campaign.create with invalid step channel", () => {
    expect(() =>
      ActionDescriptor.parse({
        kind: "campaign.create",
        tier: ApprovalTier.T2,
        name: "bad-channel",
        channel: "email",
        steps: [
          {
            position: 0,
            channel: "fax", // not in enum
            delayAfterPriorMs: 0,
            tier: "T2",
            autoApprove: false,
          },
        ],
        rationale: "x",
      }),
    ).toThrow();
  });

  it("rejects campaign.create at T1 (must be T2)", () => {
    expect(() =>
      ActionDescriptor.parse({
        kind: "campaign.create",
        tier: ApprovalTier.T1,
        name: "wrong-tier",
        channel: "email",
        steps: [
          {
            position: 0,
            channel: "email",
            delayAfterPriorMs: 0,
            tier: "T1",
            autoApprove: true,
          },
        ],
        rationale: "x",
      }),
    ).toThrow();
  });

  it("accepts a contact.add_membership at T1 with both ULIDs", () => {
    const parsed = ActionDescriptor.parse({
      kind: "contact.add_membership",
      tier: ApprovalTier.T1,
      contactId: createId(),
      organizationId: createId(),
      role: "Board Member",
      isPrimary: true,
      rationale: "Operator confirmed Faris is on file at Agrimco AG.",
    });
    expect(actionRequiresApproval(parsed)).toBe(false);
  });

  it("rejects contact.add_membership at T2", () => {
    expect(() =>
      ActionDescriptor.parse({
        kind: "contact.add_membership",
        tier: ApprovalTier.T2,
        contactId: createId(),
        organizationId: createId(),
        rationale: "x",
      }),
    ).toThrow();
  });

  it("rejects contact.add_membership with a non-ULID id", () => {
    expect(() =>
      ActionDescriptor.parse({
        kind: "contact.add_membership",
        tier: ApprovalTier.T1,
        contactId: "not-a-ulid",
        organizationId: createId(),
        rationale: "x",
      }),
    ).toThrow();
  });

  describe("whatsapp.send_template", () => {
    it("accepts a valid template send with variables", () => {
      const parsed = ActionDescriptor.parse({
        kind: "whatsapp.send_template",
        tier: ApprovalTier.T2,
        to: "+18324927169",
        contentSid: "HX0123456789abcdef0123456789abcdef",
        contentVariables: { "1": "Cole", "2": "VTC-2026-003" },
        templateName: "welcome_check_in",
        rationale: "Cold outreach to new contact",
      });
      expect(parsed.kind).toBe("whatsapp.send_template");
      expect(actionRequiresApproval(parsed)).toBe(true);
    });

    it("accepts a template with no variables", () => {
      const parsed = ActionDescriptor.parse({
        kind: "whatsapp.send_template",
        tier: ApprovalTier.T2,
        to: "+18324927169",
        contentSid: "HXaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        rationale: "Static template, no vars",
      });
      expect(parsed.kind).toBe("whatsapp.send_template");
    });

    it("rejects a malformed contentSid", () => {
      expect(() =>
        ActionDescriptor.parse({
          kind: "whatsapp.send_template",
          tier: ApprovalTier.T2,
          to: "+18324927169",
          contentSid: "not-a-content-sid",
          rationale: "x",
        }),
      ).toThrow(/HX/);
    });

    it("rejects a non-E.164 phone", () => {
      expect(() =>
        ActionDescriptor.parse({
          kind: "whatsapp.send_template",
          tier: ApprovalTier.T2,
          to: "832-492-7169",
          contentSid: "HXaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          rationale: "x",
        }),
      ).toThrow(/E.164/);
    });
  });
});
