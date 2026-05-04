import { describe, expect, it, vi } from "vitest";
import { buildEnrollmentActivities } from "./enrollment-activities.js";

type EnrollmentActivitiesDeps = Parameters<typeof buildEnrollmentActivities>[0];

/**
 * Thin mocks for the activities layer. Temporal invokes these as
 * normal async functions — no need for TestWorkflowEnvironment to
 * cover the I/O shim. The workflow itself is covered by the pure
 * gate-dsl unit tests + manual integration against a live Temporal.
 */

const TENANT = "01HSEEDWRK0000000000000001";

function buildDeps() {
  return {
    db: {
      transaction: async <T>(cb: (t: unknown) => Promise<T>) => cb({ __tx: true }),
    },
    enrollments: {
      findById: vi.fn().mockResolvedValue(null),
      advanceStep: vi.fn().mockResolvedValue(null),
      transitionState: vi.fn().mockResolvedValue(null),
    },
    steps: {
      listByCampaign: vi.fn().mockResolvedValue([]),
    },
    approvals: {
      create: vi.fn().mockResolvedValue({ id: "01HAPP0000000000000000000A" }),
      decide: vi.fn().mockResolvedValue({ id: "01HAPP0000000000000000000A" }),
    },
    touchpoints: {
      listForContactSince: vi.fn().mockResolvedValue([]),
    },
    contacts: {
      findById: vi.fn().mockResolvedValue({
        id: "ct1",
        fullName: "Cole Kutschinski",
        emails: ["cole@example.com"],
        phones: ["+18324927169"],
        orgId: "org1",
      }),
    },
    organizations: {
      findById: vi.fn().mockResolvedValue({
        id: "org1",
        legalName: "Vector Trade Capital",
      }),
    },
    events: {
      insertIfNotExists: vi.fn().mockResolvedValue(undefined),
    },
    leads: {
      findByOrgId: vi.fn().mockResolvedValue([]),
    },
    workspaces: {
      getSettings: vi.fn().mockResolvedValue({
        email_templates: [
          {
            name: "tpl_foo",
            subject: "Hi {{recipient_name}}",
            body: "Body for {{recipient_name}} at {{org_name}}.",
          },
        ],
        sms_templates: [
          { name: "tpl_foo", body: "SMS for {{recipient_name}}." },
        ],
        whatsapp_templates: [
          {
            name: "tpl_foo",
            contentSid: "HXaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            variables: ["recipient_name"],
          },
        ],
        call_templates: [
          {
            name: "tpl_foo",
            aiInstructions: "Ask {{recipient_name}} about the deal.",
          },
        ],
      }),
    },
  };
}

function asDeps(deps: ReturnType<typeof buildDeps>): EnrollmentActivitiesDeps {
  return deps as unknown as EnrollmentActivitiesDeps;
}

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

describe("enrollment activities — loadEnrollmentContext", () => {
  it("returns null when the enrollment doesn't exist", async () => {
    const deps = buildDeps();
    const activities = buildEnrollmentActivities(asDeps(deps));
    const ctx = await activities.loadEnrollmentContext({
      enrollmentId: "nope",
      tenantId: TENANT,
    });
    expect(ctx).toBeNull();
  });

  it("assembles enrollment + steps + recent signal cache + last intent", async () => {
    const deps = buildDeps();
    deps.enrollments.findById.mockResolvedValueOnce({
      id: "e1",
      tenantId: TENANT,
      campaignId: "c1",
      contactId: "ct1",
      currentStep: 0,
      state: "enrolled",
      lastEventAt: null,
      branchHistoryJson: [],
      error: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    deps.steps.listByCampaign.mockResolvedValueOnce([
      {
        id: "s0",
        position: 0,
        channel: "email",
        delayAfterPriorMs: 0,
        templateRef: "tpl_foo",
        subjectOverride: null,
        bodyOverride: null,
        gateConditionJson: {},
        tier: "T2",
        autoApprove: false,
      },
      {
        id: "s1",
        position: 1,
        channel: "sms",
        delayAfterPriorMs: 3600_000,
        templateRef: null,
        subjectOverride: null,
        bodyOverride: null,
        gateConditionJson: { intent: "interested" },
        tier: "T2",
        autoApprove: false,
      },
    ]);
    const now = new Date("2026-04-18T12:00:00Z");
    deps.touchpoints.listForContactSince.mockResolvedValueOnce([
      {
        id: "tp_open",
        metadata: { verb: "email.opened" },
        occurredAt: new Date(now.getTime() - 86400_000),
      },
      {
        id: "tp_reply",
        metadata: { verb: "email.replied", direction: "inbound", intent: "interested" },
        occurredAt: new Date(now.getTime() - 3600_000),
      },
    ]);

    const activities = buildEnrollmentActivities(asDeps(deps));
    const ctx = await activities.loadEnrollmentContext({
      enrollmentId: "e1",
      tenantId: TENANT,
    });
    expect(ctx).not.toBeNull();
    expect(ctx!.enrollment.id).toBe("e1");
    expect(ctx!.steps).toHaveLength(2);
    expect(ctx!.recentSignals.emailOpensIso).toHaveLength(1);
    expect(ctx!.recentSignals.inboundRepliesIso).toHaveLength(1);
    expect(ctx!.lastIntent).toBe("interested");
  });
});


describe("enrollment activities — dispatchStep", () => {
  function makeStep(overrides: Partial<{
    id: string;
    position: number;
    channel: string;
    templateRef: string | null;
    subjectOverride: string | null;
    bodyOverride: string | null;
    autoApprove: boolean;
    tier: string;
  }> = {}) {
    return {
      id: "s0",
      position: 0,
      channel: "email",
      delayAfterPriorMs: 0,
      templateRef: "tpl_foo" as string | null,
      subjectOverride: null as string | null,
      bodyOverride: null as string | null,
      gateConditionJson: {},
      tier: "T2",
      autoApprove: false,
      ...overrides,
    };
  }

  it("renders a templated email — subject + body substituted, payload has to/subject/body", async () => {
    const deps = buildDeps();
    const activities = buildEnrollmentActivities(asDeps(deps));
    const result = await activities.dispatchStep({
      tenantId: TENANT,
      enrollmentId: "e1",
      contactId: "ct1",
      step: makeStep({ channel: "email", templateRef: "tpl_foo" }),
    });
    expect(result.kind).toBe("approval_created");
    const createArgs = (deps.approvals.create as ReturnType<typeof vi.fn>).mock
      .calls[0]![2];
    expect(createArgs.actionType).toBe("email.send");
    expect(createArgs.proposedPayload.subject).toBe("Hi Cole");
    expect(createArgs.proposedPayload.body).toBe(
      "Body for Cole at Vector Trade Capital.",
    );
    expect(createArgs.proposedPayload.to).toEqual(["cole@example.com"]);
    expect(createArgs.proposedPayload.template_ref).toBe("tpl_foo");
  });

  it("renders an UNtemplated email from subject + body overrides", async () => {
    const deps = buildDeps();
    const activities = buildEnrollmentActivities(asDeps(deps));
    await activities.dispatchStep({
      tenantId: TENANT,
      enrollmentId: "e1",
      contactId: "ct1",
      step: makeStep({
        channel: "email",
        templateRef: null,
        subjectOverride: "Inline {{recipient_name}}",
        bodyOverride: "Inline body for {{recipient_name}}.",
      }),
    });
    const createArgs = (deps.approvals.create as ReturnType<typeof vi.fn>).mock
      .calls[0]![2];
    expect(createArgs.proposedPayload.subject).toBe("Inline Cole");
    expect(createArgs.proposedPayload.body).toBe("Inline body for Cole.");
  });

  it("auto-resolves {{procur_push_reason}} and {{recent_procur_signal}} from the contact's org's freshest procur lead", async () => {
    const deps = buildDeps();
    deps.leads.findByOrgId.mockResolvedValueOnce([
      {
        id: "L_old",
        orgId: "org1",
        updatedAt: new Date("2026-04-01T00:00:00Z"),
        procurMetadata: { pushReason: "stale lead, ignore" },
      },
      {
        id: "L_new",
        orgId: "org1",
        updatedAt: new Date("2026-05-01T00:00:00Z"),
        procurMetadata: {
          pushReason: "Buyer filed three Caribbean ULSD tenders in 14 days.",
          signals: [
            {
              kind: "tender_award",
              occurredAt: "2026-04-10T00:00:00Z",
              source: "https://procur.example/award/1",
              narrative: "Older award",
            },
            {
              kind: "rfq",
              occurredAt: "2026-04-25T00:00:00Z",
              source: "https://procur.example/rfq/9",
              narrative: "RFQ for ULSD into Pointe-à-Pitre",
            },
          ],
        },
      },
    ]);
    const activities = buildEnrollmentActivities(asDeps(deps));
    await activities.dispatchStep({
      tenantId: TENANT,
      enrollmentId: "e1",
      contactId: "ct1",
      step: makeStep({
        channel: "email",
        templateRef: null,
        subjectOverride: "Hi {{recipient_name}}",
        bodyOverride: "Reason: {{procur_push_reason}} Recent: {{recent_procur_signal}}.",
      }),
    });
    const createArgs = (deps.approvals.create as ReturnType<typeof vi.fn>).mock
      .calls[0]![2];
    expect(createArgs.proposedPayload.body).toContain(
      "Buyer filed three Caribbean ULSD tenders in 14 days.",
    );
    // Picks the FRESHEST signal narrative, not the older award.
    expect(createArgs.proposedPayload.body).toContain(
      "RFQ for ULSD into Pointe-à-Pitre",
    );
    expect(createArgs.proposedPayload.body).not.toContain("Older award");
  });

  it("leaves procur placeholders unresolved (and skips with the guard) when the org has no procur leads", async () => {
    const deps = buildDeps();
    // findByOrgId default mock returns [] — no procur leads.
    const activities = buildEnrollmentActivities(asDeps(deps));
    const result = await activities.dispatchStep({
      tenantId: TENANT,
      enrollmentId: "e1",
      contactId: "ct1",
      step: makeStep({
        channel: "email",
        templateRef: null,
        subjectOverride: "Hi {{recipient_name}}",
        bodyOverride: "Reason: {{procur_push_reason}}.",
      }),
    });
    expect(result.kind).toBe("skipped");
    expect(result.skipReason).toMatch(/procur_push_reason/);
  });

  it("renders templated SMS body with the contact's phone in the payload", async () => {
    const deps = buildDeps();
    const activities = buildEnrollmentActivities(asDeps(deps));
    await activities.dispatchStep({
      tenantId: TENANT,
      enrollmentId: "e1",
      contactId: "ct1",
      step: makeStep({ channel: "sms", templateRef: "tpl_foo" }),
    });
    const createArgs = (deps.approvals.create as ReturnType<typeof vi.fn>).mock
      .calls[0]![2];
    expect(createArgs.actionType).toBe("sms.send");
    expect(createArgs.proposedPayload.body).toBe("SMS for Cole.");
    expect(createArgs.proposedPayload.to).toBe("+18324927169");
  });

  it("flips actionType to whatsapp.send_template when a WhatsApp step references a registered template", async () => {
    const deps = buildDeps();
    const activities = buildEnrollmentActivities(asDeps(deps));
    await activities.dispatchStep({
      tenantId: TENANT,
      enrollmentId: "e1",
      contactId: "ct1",
      step: makeStep({ channel: "whatsapp", templateRef: "tpl_foo" }),
    });
    const createArgs = (deps.approvals.create as ReturnType<typeof vi.fn>).mock
      .calls[0]![2];
    expect(createArgs.actionType).toBe("whatsapp.send_template");
    expect(createArgs.proposedPayload.contentSid).toBe(
      "HXaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    );
    expect(createArgs.proposedPayload.contentVariables).toEqual({
      "1": "Cole",
    });
    expect(createArgs.proposedPayload.templateName).toBe("tpl_foo");
  });

  it("renders a voice call template into outbound_call with aiInstructions + aiMode", async () => {
    const deps = buildDeps();
    const activities = buildEnrollmentActivities(asDeps(deps));
    await activities.dispatchStep({
      tenantId: TENANT,
      enrollmentId: "e1",
      contactId: "ct1",
      step: makeStep({ channel: "voice", templateRef: "tpl_foo" }),
    });
    const createArgs = (deps.approvals.create as ReturnType<typeof vi.fn>).mock
      .calls[0]![2];
    expect(createArgs.actionType).toBe("outbound_call");
    expect(createArgs.proposedPayload.aiMode).toBe(true);
    expect(createArgs.proposedPayload.aiInstructions).toBe(
      "Ask Cole about the deal.",
    );
    expect(createArgs.proposedPayload.toNumber).toBe("+18324927169");
    expect(createArgs.proposedPayload.orgId).toBe("org1");
  });

  it("auto-approves and emits enrollment.step.auto_approved when step.autoApprove is true", async () => {
    const deps = buildDeps();
    const activities = buildEnrollmentActivities(asDeps(deps));
    const result = await activities.dispatchStep({
      tenantId: TENANT,
      enrollmentId: "e1",
      contactId: "ct1",
      step: makeStep({ channel: "email", templateRef: "tpl_foo", autoApprove: true }),
    });
    expect(result.kind).toBe("auto_approved");
    expect(deps.approvals.decide).toHaveBeenCalledOnce();
    const eventArgs = (deps.events.insertIfNotExists as ReturnType<typeof vi.fn>).mock
      .calls[0]![2];
    expect(eventArgs.verb).toBe("enrollment.step.auto_approved");
  });

  it("skips with a clear reason when the named template isn't registered", async () => {
    const deps = buildDeps();
    const activities = buildEnrollmentActivities(asDeps(deps));
    const result = await activities.dispatchStep({
      tenantId: TENANT,
      enrollmentId: "e1",
      contactId: "ct1",
      step: makeStep({ channel: "email", templateRef: "no_such_template" }),
    });
    expect(result.kind).toBe("skipped");
    expect(result.skipReason).toMatch(/email template "no_such_template" not registered/);
    expect(deps.approvals.create).not.toHaveBeenCalled();
  });

  it("skips when contact has no email on file for an email step", async () => {
    const deps = buildDeps();
    deps.contacts.findById.mockResolvedValueOnce({
      id: "ct1",
      fullName: "Cole",
      emails: [],
      phones: ["+18324927169"],
      orgId: "org1",
    });
    const activities = buildEnrollmentActivities(asDeps(deps));
    const result = await activities.dispatchStep({
      tenantId: TENANT,
      enrollmentId: "e1",
      contactId: "ct1",
      step: makeStep({ channel: "email", templateRef: "tpl_foo" }),
    });
    expect(result.kind).toBe("skipped");
    expect(result.skipReason).toMatch(/no email on file/);
  });

  it("skips manual steps before any resolution", async () => {
    const deps = buildDeps();
    const activities = buildEnrollmentActivities(asDeps(deps));
    const result = await activities.dispatchStep({
      tenantId: TENANT,
      enrollmentId: "e1",
      contactId: "ct1",
      step: makeStep({ channel: "manual", templateRef: null }),
    });
    expect(result.kind).toBe("skipped");
    expect(result.skipReason).toBe("manual_or_unknown_channel");
    expect(deps.contacts.findById).not.toHaveBeenCalled();
  });
});

describe("enrollment activities — evaluateStepGate", () => {
  it("delegates to evaluateGate and serializes timestamps", async () => {
    const deps = buildDeps();
    const activities = buildEnrollmentActivities(asDeps(deps));
    const now = new Date();
    const recent = new Date(now.getTime() - 86400_000);
    const result = await activities.evaluateStepGate({
      gateConditionJson: { opened_in_last_days: 7 },
      signals: {
        emailOpensIso: [recent.toISOString()],
        emailClicksIso: [],
        inboundRepliesIso: [],
      },
      lastIntent: null,
      enrollmentState: "enrolled",
    });
    expect(result.ok).toBe(true);
  });
});
