import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildApprovalExecutor } from "./runner.js";

/**
 * The approval executor's core responsibility is branching on
 * approval.actionType and calling the right repository method with
 * the payload's fields. We mock every repo + EventRepository and
 * assert the correct side effects fire for each branch.
 *
 * `withTenant` is mocked to pass a stub tx through — the repos
 * themselves are mocked so the tx is never touched directly.
 */

const TENANT = "01HSEEDWRK0000000000000001";
const APPROVAL_ID = "01HAPP0000000000000000000A";

vi.mock("@vex/db", async () => {
  const actual = await vi.importActual<Record<string, unknown>>("@vex/db");
  return {
    ...actual,
    withTenant: async (
      _db: unknown,
      _tenantId: string,
      fn: (tx: unknown) => Promise<unknown>,
    ) => fn({ __fake_tx: true }),
  };
});

function buildDeps(
  approval: {
    id?: string;
    actionType: string;
    decision: "approved" | "rejected" | "pending" | "auto_approved";
    proposedPayload: unknown;
    reviewerId?: string | null;
  } | null,
) {
  const approvalRow = approval
    ? {
        id: approval.id ?? APPROVAL_ID,
        reviewerId: approval.reviewerId ?? "01HSEEDPRS0000000000000001",
        appliedObjectId: null as string | null,
        ...approval,
      }
    : null;

  // Drop per-field `as never` casts: they collapse the inner vi.fn
  // types to `never`, which kills `.mock.calls` access in test
  // assertions. Inferring the literal type keeps the Mock typing.
  const deps = {
    db: {},
    approvals: {
      findById: vi.fn().mockResolvedValue(approvalRow),
      markApplied: vi.fn().mockResolvedValue(undefined),
    },
    deals: {
      updateStatus: vi.fn().mockResolvedValue(undefined),
      create: vi.fn().mockResolvedValue(undefined),
    },
    organizations: {
      create: vi.fn().mockResolvedValue(undefined),
      // applyCreateDeal validates buyer existence against this. Default
      // to a non-null row so existing tests don't have to thread it.
      findById: vi.fn().mockResolvedValue({ id: "01HSEEDCRP0000000000000001" }),
      // Pass C unified dedupe path. Default to "created" so the
      // existing happy-path tests still assert new-org behavior.
      createWithDedupeCheck: vi
        .fn()
        .mockImplementation(
          async (_tx: unknown, _tenantId: string, input: { id: string }) => ({
            kind: "created" as const,
            organization: { id: input.id },
          }),
        ),
    },
    contacts: {
      create: vi.fn().mockResolvedValue(undefined),
      // See organizations.createWithDedupeCheck above.
      createWithDedupeCheck: vi
        .fn()
        .mockImplementation(
          async (_tx: unknown, _tenantId: string, input: { id: string }) => ({
            kind: "created" as const,
            contact: { id: input.id },
          }),
        ),
    },
    memberships: {
      create: vi.fn().mockResolvedValue(undefined),
    },
    touchpoints: {
      insert: vi.fn().mockResolvedValue({ id: "tp-1" }),
    },
    events: {
      insertIfNotExists: vi.fn().mockResolvedValue(undefined),
    },
    // Twilio — default: both channels succeed. Individual tests
    // override to simulate errors or a null-client path.
    twilio: {
      sendSms: vi
        .fn()
        .mockResolvedValue({ sid: "SM_TEST", error: null, segments: 1 }),
      sendWhatsApp: vi
        .fn()
        .mockResolvedValue({ sid: "WA_TEST", error: null, segments: null }),
    },
    costLedger: {
      record: vi.fn().mockResolvedValue(undefined),
    },
    // Freeze time at 14:00 UTC so default quiet-hours (08:00–21:00) is
    // satisfied regardless of where the test host clock happens to be.
    now: () => new Date("2026-04-18T14:00:00Z"),
  };

  return deps;
}

function runJob(deps: ReturnType<typeof buildDeps>): Promise<void> {
  // Cast at the boundary — buildApprovalExecutor expects the full
  // repo interfaces; we only stub the methods the executor actually
  // calls, so a structural mismatch is intentional.
  const executor = buildApprovalExecutor(
    deps as unknown as Parameters<typeof buildApprovalExecutor>[0],
  );
  return executor({
    data: { approval_id: APPROVAL_ID, workspace_id: TENANT },
  } as never);
}

describe("approval executor — deal.status_change", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("applies the status change and emits deal.status_changed", async () => {
    const deps = buildDeps({
      actionType: "deal.status_change",
      decision: "approved",
      proposedPayload: {
        deal_id: "01HSEEDDEA0000000000000001",
        deal_ref: "VTC-2026-001",
        from_status: "negotiating",
        to_status: "approved",
        rationale: "OFAC cleared",
      },
    });

    await runJob(deps);

    expect(deps.deals.updateStatus).toHaveBeenCalledOnce();
    const updateArgs = deps.deals.updateStatus.mock.calls[0]!;
    expect(updateArgs[1]).toBe("01HSEEDDEA0000000000000001");
    expect(updateArgs[2]).toBe("approved");
    expect(updateArgs[3]).toBe("01HSEEDPRS0000000000000001");

    const event = deps.events.insertIfNotExists.mock.calls[0]![2];
    expect(event.verb).toBe("deal.status_changed");
    expect(event.metadata).toMatchObject({
      approval_id: APPROVAL_ID,
      deal_ref: "VTC-2026-001",
      from_status: "negotiating",
      to_status: "approved",
    });
  });

  it("emits approval.executor.failed when deal_id is missing", async () => {
    const deps = buildDeps({
      actionType: "deal.status_change",
      decision: "approved",
      proposedPayload: { to_status: "approved" },
    });
    await runJob(deps);
    expect(deps.deals.updateStatus).not.toHaveBeenCalled();
    const event = deps.events.insertIfNotExists.mock.calls[0]![2];
    expect(event.verb).toBe("approval.executor.failed");
  });

  it("falls through to the received-log branch when decision !== approved", async () => {
    const deps = buildDeps({
      actionType: "deal.status_change",
      decision: "rejected",
      proposedPayload: {
        deal_id: "01HSEEDDEA0000000000000001",
        to_status: "approved",
      },
    });
    await runJob(deps);
    expect(deps.deals.updateStatus).not.toHaveBeenCalled();
    const event = deps.events.insertIfNotExists.mock.calls[0]![2];
    expect(event.verb).toBe("approval.executor.received");
  });
});

describe("approval executor — crm.create_company", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("creates the organization and emits organization.created", async () => {
    const deps = buildDeps({
      actionType: "crm.create_company",
      decision: "approved",
      proposedPayload: {
        legalName: "Harbour Bunkers",
        domain: "harbourbunkers.test",
        industry: "Bunkering",
        rationale: "Caribbean inbound lane",
      },
    });
    await runJob(deps);

    expect(deps.organizations.createWithDedupeCheck).toHaveBeenCalledOnce();
    const [, tenantArg, input] = deps.organizations.createWithDedupeCheck.mock.calls[0]!;
    expect(tenantArg).toBe(TENANT);
    expect(input.legalName).toBe("Harbour Bunkers");
    expect(input.domain).toBe("harbourbunkers.test");
    expect(input.industry).toBe("Bunkering");
    expect(typeof input.id).toBe("string");

    const event = deps.events.insertIfNotExists.mock.calls[0]![2];
    expect(event.verb).toBe("organization.created");
    expect(event.metadata.rationale).toBe("Caribbean inbound lane");
  });

  it("emits approval.executor.failed when legalName is missing", async () => {
    const deps = buildDeps({
      actionType: "crm.create_company",
      decision: "approved",
      proposedPayload: {},
    });
    await runJob(deps);
    expect(deps.organizations.create).not.toHaveBeenCalled();
    const event = deps.events.insertIfNotExists.mock.calls[0]![2];
    expect(event.verb).toBe("approval.executor.failed");
  });

  it("skips the insert and emits a replay event when appliedObjectId is set", async () => {
    // Simulates a queue retry after a prior successful apply: the
    // approval row already carries the created org id, so the
    // executor must short-circuit instead of minting a duplicate.
    const deps = buildDeps({
      actionType: "crm.create_company",
      decision: "approved",
      proposedPayload: { legalName: "Harbour Bunkers" },
    });
    deps.approvals.findById.mockResolvedValueOnce({
      id: APPROVAL_ID,
      reviewerId: "01HSEEDPRS0000000000000001",
      actionType: "crm.create_company",
      decision: "approved",
      proposedPayload: { legalName: "Harbour Bunkers" },
      appliedObjectId: "01HSEEDCRP0000000000000099",
    });
    await runJob(deps);
    expect(deps.organizations.create).not.toHaveBeenCalled();
    expect(deps.approvals.markApplied).not.toHaveBeenCalled();
    const event = deps.events.insertIfNotExists.mock.calls[0]![2];
    expect(event.verb).toBe("approval.executor.replayed");
    expect(event.metadata.applied_object_id).toBe(
      "01HSEEDCRP0000000000000099",
    );
  });
});

describe("approval executor — crm.create_contact", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("creates the contact + one membership per org", async () => {
    const deps = buildDeps({
      actionType: "crm.create_contact",
      decision: "approved",
      proposedPayload: {
        fullName: "Jane Trader",
        title: "VP Fuel",
        emails: ["jane@acme.test"],
        orgs: [
          { orgId: "01HSEEDCRP0000000000000001", isPrimary: true, role: "VP" },
          { orgId: "01HSEEDCRP0000000000000002", isPrimary: false, role: "Advisor" },
        ],
        rationale: "Shared advisor across orgs",
      },
    });
    await runJob(deps);

    expect(deps.contacts.createWithDedupeCheck).toHaveBeenCalledOnce();
    const contactInput = deps.contacts.createWithDedupeCheck.mock.calls[0]![2];
    expect(contactInput.fullName).toBe("Jane Trader");
    expect(contactInput.orgId).toBe("01HSEEDCRP0000000000000001");

    expect(deps.memberships.create).toHaveBeenCalledTimes(2);
    const firstMembership = deps.memberships.create.mock.calls[0]![2];
    expect(firstMembership.isPrimary).toBe(true);
    expect(firstMembership.orgId).toBe("01HSEEDCRP0000000000000001");
    const secondMembership = deps.memberships.create.mock.calls[1]![2];
    expect(secondMembership.isPrimary).toBe(false);
    expect(secondMembership.orgId).toBe("01HSEEDCRP0000000000000002");

    const event = deps.events.insertIfNotExists.mock.calls[0]![2];
    expect(event.verb).toBe("contact.created");
    expect(event.metadata.org_count).toBe(2);
  });

  it("picks the first org as primary when none is flagged", async () => {
    const deps = buildDeps({
      actionType: "crm.create_contact",
      decision: "approved",
      proposedPayload: {
        fullName: "Unflagged",
        orgs: [
          { orgId: "01HSEEDCRP0000000000000001" },
          { orgId: "01HSEEDCRP0000000000000002" },
        ],
        rationale: "auto-primary",
      },
    });
    await runJob(deps);
    const firstMembership = deps.memberships.create.mock.calls[0]![2];
    expect(firstMembership.isPrimary).toBe(true);
    const secondMembership = deps.memberships.create.mock.calls[1]![2];
    expect(secondMembership.isPrimary).toBe(false);
  });

  it("refuses payloads marking multiple primaries", async () => {
    const deps = buildDeps({
      actionType: "crm.create_contact",
      decision: "approved",
      proposedPayload: {
        fullName: "Bad",
        orgs: [
          { orgId: "01HSEEDCRP0000000000000001", isPrimary: true },
          { orgId: "01HSEEDCRP0000000000000002", isPrimary: true },
        ],
        rationale: "r",
      },
    });
    await runJob(deps);
    expect(deps.contacts.create).not.toHaveBeenCalled();
    const event = deps.events.insertIfNotExists.mock.calls[0]![2];
    expect(event.verb).toBe("approval.executor.failed");
    expect(event.metadata.reason).toMatch(/more than one primary/);
  });
});

describe("approval executor — crm.create_deal", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("creates the deal with the full payload + rationale audit", async () => {
    const deps = buildDeps({
      actionType: "crm.create_deal",
      decision: "approved",
      proposedPayload: {
        dealRef: "VTC-2026-TEST",
        product: "ulsd",
        incoterm: "cfr",
        pricingBasis: "platts",
        paymentTerms: "lc_sight",
        volumeUsg: 2_500_000,
        densityKgL: 0.84,
        buyerOrgId: "01HSEEDCRP0000000000000006",
        destinationPort: "Kingston",
        rationale: "Q2 supply window",
      },
    });
    await runJob(deps);

    expect(deps.deals.create).toHaveBeenCalledOnce();
    const input = deps.deals.create.mock.calls[0]![2];
    expect(input.dealRef).toBe("VTC-2026-TEST");
    expect(input.product).toBe("ulsd");
    expect(input.volumeUsg).toBe(2_500_000);
    expect(input.destinationPort).toBe("Kingston");

    const event = deps.events.insertIfNotExists.mock.calls[0]![2];
    expect(event.verb).toBe("deal.created");
    expect(event.metadata.rationale).toBe("Q2 supply window");
  });

  it("fails closed when a required enum field is missing", async () => {
    const deps = buildDeps({
      actionType: "crm.create_deal",
      decision: "approved",
      proposedPayload: {
        dealRef: "VTC-2026-TEST",
        // missing product, incoterm, etc.
        volumeUsg: 1000,
        densityKgL: 0.84,
        buyerOrgId: "01HSEEDCRP0000000000000001",
        rationale: "r",
      },
    });
    await runJob(deps);
    expect(deps.deals.create).not.toHaveBeenCalled();
    const event = deps.events.insertIfNotExists.mock.calls[0]![2];
    expect(event.verb).toBe("approval.executor.failed");
  });
});

describe("approval executor — unknown action types", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("logs the received event without side effects", async () => {
    const deps = buildDeps({
      actionType: "email.send",
      decision: "approved",
      proposedPayload: { to: ["x@test"], subject: "s", body: "b" },
    });
    await runJob(deps);
    expect(deps.deals.create).not.toHaveBeenCalled();
    expect(deps.contacts.create).not.toHaveBeenCalled();
    expect(deps.organizations.create).not.toHaveBeenCalled();
    const event = deps.events.insertIfNotExists.mock.calls[0]![2];
    expect(event.verb).toBe("approval.executor.received");
    expect(event.metadata.action_type).toBe("email.send");
  });

  it("noops when the approval doesn't exist", async () => {
    const deps = buildDeps(null);
    await runJob(deps);
    expect(deps.events.insertIfNotExists).not.toHaveBeenCalled();
  });
});

describe("approval executor — sms.send", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  const validPayload = {
    to: "+15555551234",
    body: "Hey — any update on the Q3 ULSD plan? Happy to jump on a quick call.",
    contact_id: "01HSEEDCNT0000000000000001",
    org_id: "01HSEEDCRP0000000000000001",
    campaign_id: "01HSEEDCPN0000000000000001",
    timezone: "America/New_York",
    rationale: "48h since last touch, warm band",
  };

  it("dispatches via Twilio, records per-segment cost, touchpoint, markApplied, audit", async () => {
    const deps = buildDeps({
      actionType: "sms.send",
      decision: "approved",
      proposedPayload: validPayload,
    });
    deps.twilio.sendSms.mockResolvedValueOnce({
      sid: "SM_ACK",
      error: null,
      segments: 2,
    });

    await runJob(deps);

    expect(deps.twilio.sendSms).toHaveBeenCalledWith({
      to: validPayload.to,
      body: validPayload.body,
    });

    const [, tenantArg, tpData] = deps.touchpoints.insert.mock.calls[0]!;
    expect(tenantArg).toBe(TENANT);
    expect(tpData.channel).toBe("sms");
    expect(tpData.contactId).toBe(validPayload.contact_id);
    expect(tpData.metadata.provider_message_sid).toBe("SM_ACK");
    expect(tpData.metadata.segments).toBe(2);

    const ledgerEntry = deps.costLedger.record.mock.calls[0]![0];
    expect(ledgerEntry.operation).toBe("sms.send");
    expect(ledgerEntry.units).toBe(2);
    // $0.0083/segment * 2 segments = $0.0166 = 16600 micros.
    expect(ledgerEntry.costUsdMicros).toBe(16600);

    expect(deps.approvals.markApplied).toHaveBeenCalledWith(
      expect.anything(),
      APPROVAL_ID,
      "SM_ACK",
    );
    const event = deps.events.insertIfNotExists.mock.calls[0]![2];
    expect(event.verb).toBe("sms.sent");
    expect(event.metadata.segments).toBe(2);
  });

  it("blocks outside quiet hours (recipient-local)", async () => {
    const deps = buildDeps({
      actionType: "sms.send",
      decision: "approved",
      proposedPayload: validPayload,
    });
    // 06:00 UTC = 02:00 America/New_York → outside 08:00–21:00.
    deps.now = () => new Date("2026-04-18T06:00:00Z");

    await runJob(deps);
    expect(deps.twilio.sendSms).not.toHaveBeenCalled();
    expect(deps.costLedger.record).not.toHaveBeenCalled();
    expect(deps.touchpoints.insert).not.toHaveBeenCalled();
    const event = deps.events.insertIfNotExists.mock.calls[0]![2];
    expect(event.verb).toBe("approval.executor.failed");
    expect(event.metadata.reason).toBe("quiet_hours");
  });

  it("fails closed with sms.send_not_configured when Twilio is absent", async () => {
    const deps = buildDeps({
      actionType: "sms.send",
      decision: "approved",
      proposedPayload: validPayload,
    });
    (deps as { twilio: unknown }).twilio = null;

    await runJob(deps);
    expect(deps.touchpoints.insert).not.toHaveBeenCalled();
    expect(deps.costLedger.record).not.toHaveBeenCalled();
    const event = deps.events.insertIfNotExists.mock.calls[0]![2];
    expect(event.verb).toBe("approval.executor.failed");
    expect(event.metadata.reason).toBe("sms.send_not_configured");
  });

  it("surfaces Twilio errors without marking applied or recording cost", async () => {
    const deps = buildDeps({
      actionType: "sms.send",
      decision: "approved",
      proposedPayload: validPayload,
    });
    deps.twilio.sendSms.mockResolvedValueOnce({
      sid: null,
      error: "21610: message cannot be sent because the recipient has opted out",
      segments: null,
    });
    await runJob(deps);
    expect(deps.approvals.markApplied).not.toHaveBeenCalled();
    expect(deps.costLedger.record).not.toHaveBeenCalled();
    expect(deps.touchpoints.insert).not.toHaveBeenCalled();
    const event = deps.events.insertIfNotExists.mock.calls[0]![2];
    expect(event.verb).toBe("approval.executor.failed");
    expect(event.metadata.reason).toMatch(/opted out/);
  });

  it("short-circuits to replay when appliedObjectId is already set", async () => {
    const deps = buildDeps({
      actionType: "sms.send",
      decision: "approved",
      proposedPayload: validPayload,
    });
    deps.approvals.findById.mockResolvedValue({
      id: APPROVAL_ID,
      reviewerId: "01HSEEDPRS0000000000000001",
      actionType: "sms.send",
      decision: "approved",
      proposedPayload: validPayload,
      appliedObjectId: "SM_PRIOR",
    });
    await runJob(deps);
    expect(deps.twilio.sendSms).not.toHaveBeenCalled();
    expect(deps.costLedger.record).not.toHaveBeenCalled();
    const event = deps.events.insertIfNotExists.mock.calls[0]![2];
    expect(event.verb).toBe("approval.executor.replayed");
    expect(event.metadata.action_type).toBe("sms.send");
  });
});

describe("approval executor — whatsapp.send", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  const templatePayload = {
    to: "+15555551234",
    content_sid: "HX00000000000000000000000000000000",
    content_variables: { "1": "Acme", "2": "Q3 ULSD" },
    contact_id: "01HSEEDCNT0000000000000001",
    timezone: "America/New_York",
    rationale: "business-initiated outreach",
  };

  const freeFormPayload = {
    to: "+15555551234",
    body: "Got your reply — can we lock the 4.8M gal for June?",
    in_session: true,
    contact_id: "01HSEEDCNT0000000000000001",
    timezone: "America/New_York",
  };

  it("dispatches a template message and charges the business-initiated rate", async () => {
    const deps = buildDeps({
      actionType: "whatsapp.send",
      decision: "approved",
      proposedPayload: templatePayload,
    });
    await runJob(deps);

    expect(deps.twilio.sendWhatsApp).toHaveBeenCalledWith(
      expect.objectContaining({
        to: templatePayload.to,
        contentSid: templatePayload.content_sid,
        contentVariables: templatePayload.content_variables,
      }),
    );
    const ledgerEntry = deps.costLedger.record.mock.calls[0]![0];
    expect(ledgerEntry.operation).toBe("whatsapp.send");
    // $0.03 business-initiated.
    expect(ledgerEntry.costUsdMicros).toBe(30000);
    expect(deps.approvals.markApplied).toHaveBeenCalled();
    const event = deps.events.insertIfNotExists.mock.calls[0]![2];
    expect(event.verb).toBe("whatsapp.sent");
    expect(event.metadata.template_sid).toBe(templatePayload.content_sid);
  });

  it("dispatches a free-form reply at the cheaper session rate when in_session=true", async () => {
    const deps = buildDeps({
      actionType: "whatsapp.send",
      decision: "approved",
      proposedPayload: freeFormPayload,
    });
    await runJob(deps);
    const ledgerEntry = deps.costLedger.record.mock.calls[0]![0];
    // $0.005 session.
    expect(ledgerEntry.costUsdMicros).toBe(5000);
    const event = deps.events.insertIfNotExists.mock.calls[0]![2];
    expect(event.metadata.in_session).toBe(true);
    expect(event.metadata.template_sid).toBe(null);
  });

  it("fails closed on free-form body without in_session=true (template required)", async () => {
    const deps = buildDeps({
      actionType: "whatsapp.send",
      decision: "approved",
      proposedPayload: { ...freeFormPayload, in_session: false },
    });
    await runJob(deps);
    expect(deps.twilio.sendWhatsApp).not.toHaveBeenCalled();
    expect(deps.costLedger.record).not.toHaveBeenCalled();
    const event = deps.events.insertIfNotExists.mock.calls[0]![2];
    expect(event.verb).toBe("approval.executor.failed");
    expect(event.metadata.reason).toBe("free_form_requires_open_session");
  });

  it("fails closed with whatsapp_not_configured when Twilio is absent", async () => {
    const deps = buildDeps({
      actionType: "whatsapp.send",
      decision: "approved",
      proposedPayload: templatePayload,
    });
    (deps as { twilio: unknown }).twilio = null;
    await runJob(deps);
    expect(deps.costLedger.record).not.toHaveBeenCalled();
    const event = deps.events.insertIfNotExists.mock.calls[0]![2];
    expect(event.verb).toBe("approval.executor.failed");
    expect(event.metadata.reason).toBe("whatsapp_not_configured");
  });

  it("blocks outside quiet hours", async () => {
    const deps = buildDeps({
      actionType: "whatsapp.send",
      decision: "approved",
      proposedPayload: templatePayload,
    });
    deps.now = () => new Date("2026-04-18T03:00:00Z");
    await runJob(deps);
    expect(deps.twilio.sendWhatsApp).not.toHaveBeenCalled();
    const event = deps.events.insertIfNotExists.mock.calls[0]![2];
    expect(event.verb).toBe("approval.executor.failed");
    expect(event.metadata.reason).toBe("quiet_hours");
  });
});
