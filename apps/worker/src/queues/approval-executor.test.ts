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
    // Default: email.send branch succeeds. Individual tests override
    // `send` to simulate provider errors or the null-client path.
    resend: {
      send: vi.fn().mockResolvedValue({ id: "resend-msg-1", error: null }),
    },
    costLedger: {
      record: vi.fn().mockResolvedValue(undefined),
    },
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
      actionType: "lead.close",
      decision: "approved",
      proposedPayload: { leadId: "x", outcome: "won", reason: "y" },
    });
    await runJob(deps);
    expect(deps.deals.create).not.toHaveBeenCalled();
    expect(deps.contacts.create).not.toHaveBeenCalled();
    expect(deps.organizations.create).not.toHaveBeenCalled();
    const event = deps.events.insertIfNotExists.mock.calls[0]![2];
    expect(event.verb).toBe("approval.executor.received");
    expect(event.metadata.action_type).toBe("lead.close");
  });

  it("noops when the approval doesn't exist", async () => {
    const deps = buildDeps(null);
    await runJob(deps);
    expect(deps.events.insertIfNotExists).not.toHaveBeenCalled();
  });
});

describe("approval executor — email.send", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  const validPayload = {
    to: ["buyer@acme.test"],
    subject: "Spring program check-in",
    body: "Wanted to see if timing has shifted on your Q3 ULSD plan.",
    contact_id: "01HSEEDCNT0000000000000001",
    org_id: "01HSEEDCRP0000000000000001",
    campaign_id: "01HSEEDCPN0000000000000001",
    rationale: "buyer readiness: hot",
  };

  it("dispatches through Resend, lands a touchpoint, records cost, emits email.sent", async () => {
    const deps = buildDeps({
      actionType: "email.send",
      decision: "approved",
      proposedPayload: validPayload,
    });
    await runJob(deps);

    expect(deps.resend.send).toHaveBeenCalledOnce();
    const [sendArgs] = deps.resend.send.mock.calls[0]!;
    expect(sendArgs.to).toEqual(["buyer@acme.test"]);
    expect(sendArgs.subject).toBe("Spring program check-in");
    expect(sendArgs.text).toBe(validPayload.body);

    expect(deps.touchpoints.insert).toHaveBeenCalledOnce();
    const [, tenantArg, tpData] = deps.touchpoints.insert.mock.calls[0]!;
    expect(tenantArg).toBe(TENANT);
    expect(tpData.channel).toBe("email");
    expect(tpData.contactId).toBe(validPayload.contact_id);
    expect(tpData.orgId).toBe(validPayload.org_id);
    expect(tpData.campaignId).toBe(validPayload.campaign_id);
    expect(tpData.metadata.provider_message_id).toBe("resend-msg-1");

    expect(deps.costLedger.record).toHaveBeenCalledOnce();
    const ledgerEntry = deps.costLedger.record.mock.calls[0]![0];
    expect(ledgerEntry.operation).toBe("email.send");
    expect(ledgerEntry.units).toBe(1);
    expect(ledgerEntry.costUsdMicros).toBeGreaterThan(0);
    expect(ledgerEntry.idempotencyKey).toBe(`email.send:${APPROVAL_ID}`);

    expect(deps.approvals.markApplied).toHaveBeenCalledWith(
      expect.anything(),
      APPROVAL_ID,
      "resend-msg-1",
    );

    const event = deps.events.insertIfNotExists.mock.calls[0]![2];
    expect(event.verb).toBe("email.sent");
    expect(event.metadata.provider_message_id).toBe("resend-msg-1");
    expect(event.metadata.recipient_count).toBe(1);
  });

  it("emits approval.executor.failed when `to` is empty", async () => {
    const deps = buildDeps({
      actionType: "email.send",
      decision: "approved",
      proposedPayload: { ...validPayload, to: [] },
    });
    await runJob(deps);
    expect(deps.resend.send).not.toHaveBeenCalled();
    expect(deps.touchpoints.insert).not.toHaveBeenCalled();
    expect(deps.costLedger.record).not.toHaveBeenCalled();
    const event = deps.events.insertIfNotExists.mock.calls[0]![2];
    expect(event.verb).toBe("approval.executor.failed");
    expect(event.metadata.reason).toBe("missing to, subject, or body");
  });

  it("fails closed with email.send_not_configured when Resend is absent", async () => {
    const deps = buildDeps({
      actionType: "email.send",
      decision: "approved",
      proposedPayload: validPayload,
    });
    // Override — workspace without Resend credentials.
    (deps as { resend: unknown }).resend = null;
    await runJob(deps);
    expect(deps.touchpoints.insert).not.toHaveBeenCalled();
    expect(deps.costLedger.record).not.toHaveBeenCalled();
    expect(deps.approvals.markApplied).not.toHaveBeenCalled();
    const event = deps.events.insertIfNotExists.mock.calls[0]![2];
    expect(event.verb).toBe("approval.executor.failed");
    expect(event.metadata.reason).toBe("email.send_not_configured");
  });

  it("surfaces provider errors without marking applied or recording cost", async () => {
    const deps = buildDeps({
      actionType: "email.send",
      decision: "approved",
      proposedPayload: validPayload,
    });
    deps.resend.send.mockResolvedValueOnce({
      id: null,
      error: "validation_error: From address not verified",
    });
    await runJob(deps);
    expect(deps.approvals.markApplied).not.toHaveBeenCalled();
    expect(deps.costLedger.record).not.toHaveBeenCalled();
    expect(deps.touchpoints.insert).not.toHaveBeenCalled();
    const event = deps.events.insertIfNotExists.mock.calls[0]![2];
    expect(event.verb).toBe("approval.executor.failed");
    expect(event.metadata.reason).toMatch(/From address not verified/);
  });

  it("short-circuits to a replay event when appliedObjectId is already set", async () => {
    const deps = buildDeps({
      actionType: "email.send",
      decision: "approved",
      proposedPayload: validPayload,
    });
    // Simulate a prior successful run that stamped the approval with
    // the provider message id. The executor must NOT re-send.
    deps.approvals.findById.mockResolvedValue({
      id: APPROVAL_ID,
      reviewerId: "01HSEEDPRS0000000000000001",
      actionType: "email.send",
      decision: "approved",
      proposedPayload: validPayload,
      appliedObjectId: "resend-msg-prior",
    });

    await runJob(deps);
    expect(deps.resend.send).not.toHaveBeenCalled();
    expect(deps.touchpoints.insert).not.toHaveBeenCalled();
    expect(deps.costLedger.record).not.toHaveBeenCalled();
    expect(deps.approvals.markApplied).not.toHaveBeenCalled();
    const event = deps.events.insertIfNotExists.mock.calls[0]![2];
    expect(event.verb).toBe("approval.executor.replayed");
    expect(event.metadata.action_type).toBe("email.send");
  });

  it("charges Resend cost per recipient", async () => {
    const deps = buildDeps({
      actionType: "email.send",
      decision: "approved",
      proposedPayload: { ...validPayload, to: ["a@t", "b@t", "c@t"] },
    });
    await runJob(deps);
    const ledgerEntry = deps.costLedger.record.mock.calls[0]![0];
    expect(ledgerEntry.units).toBe(3);
    // $0.0004/msg * 3 = $0.0012 = 1200 micros.
    expect(ledgerEntry.costUsdMicros).toBe(1200);
  });
});
