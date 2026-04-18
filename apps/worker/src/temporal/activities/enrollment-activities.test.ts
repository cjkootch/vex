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
    contacts: {},
    events: {
      insertIfNotExists: vi.fn().mockResolvedValue(undefined),
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
  it("creates an approval + emits enrollment.step.approval_created for a T2 email step", async () => {
    const deps = buildDeps();
    const activities = buildEnrollmentActivities(asDeps(deps));
    const result = await activities.dispatchStep({
      tenantId: TENANT,
      enrollmentId: "e1",
      contactId: "ct1",
      step: {
        id: "s0",
        position: 0,
        channel: "email",
        delayAfterPriorMs: 0,
        templateRef: "tpl_foo",
        gateConditionJson: {},
        tier: "T2",
        autoApprove: false,
      },
    });
    expect(result.kind).toBe("approval_created");
    expect(result.approvalId).toBeTruthy();
    const createArgs = (deps.approvals.create as ReturnType<typeof vi.fn>).mock
      .calls[0]![2];
    expect(createArgs.actionType).toBe("email.send");
    expect(createArgs.proposedPayload.step_id).toBe("s0");
    expect(createArgs.proposedPayload.auto_approved).toBe(false);
    expect(deps.approvals.decide).not.toHaveBeenCalled();

    const eventArgs = (deps.events.insertIfNotExists as ReturnType<typeof vi.fn>).mock
      .calls[0]![2];
    expect(eventArgs.verb).toBe("enrollment.step.approval_created");
  });

  it("auto-approves when step.autoApprove is true and emits the auto_approved event", async () => {
    const deps = buildDeps();
    const activities = buildEnrollmentActivities(asDeps(deps));
    const result = await activities.dispatchStep({
      tenantId: TENANT,
      enrollmentId: "e1",
      contactId: "ct1",
      step: {
        id: "s0",
        position: 0,
        channel: "email",
        delayAfterPriorMs: 0,
        templateRef: "tpl_foo",
        gateConditionJson: {},
        tier: "T2",
        autoApprove: true,
      },
    });
    expect(result.kind).toBe("auto_approved");
    expect(deps.approvals.decide).toHaveBeenCalledOnce();
    const decideArgs = (deps.approvals.decide as ReturnType<typeof vi.fn>).mock
      .calls[0]!;
    expect(decideArgs[2]).toBe("auto_approved");
    const eventArgs = (deps.events.insertIfNotExists as ReturnType<typeof vi.fn>).mock
      .calls[0]![2];
    expect(eventArgs.verb).toBe("enrollment.step.auto_approved");
  });

  it("maps channel → executor action type for all wired channels", async () => {
    const deps = buildDeps();
    const activities = buildEnrollmentActivities(asDeps(deps));
    const channels: Array<{ channel: string; expected: string }> = [
      { channel: "email", expected: "email.send" },
      { channel: "sms", expected: "sms.send" },
      { channel: "whatsapp", expected: "whatsapp.send" },
      { channel: "voice", expected: "outbound_call" },
    ];
    for (const { channel, expected } of channels) {
      (deps.approvals.create as ReturnType<typeof vi.fn>).mockClear();
      await activities.dispatchStep({
        tenantId: TENANT,
        enrollmentId: "e1",
        contactId: "ct1",
        step: {
          id: `s-${channel}`,
          position: 0,
          channel,
          delayAfterPriorMs: 0,
          templateRef: null,
          gateConditionJson: {},
          tier: "T2",
          autoApprove: false,
        },
      });
      const createArgs = (deps.approvals.create as ReturnType<typeof vi.fn>).mock
        .calls[0]![2];
      expect(createArgs.actionType).toBe(expected);
    }
  });

  it("skips (no approval) for a manual step and reports skipReason", async () => {
    const deps = buildDeps();
    const activities = buildEnrollmentActivities(asDeps(deps));
    const result = await activities.dispatchStep({
      tenantId: TENANT,
      enrollmentId: "e1",
      contactId: "ct1",
      step: {
        id: "s_manual",
        position: 0,
        channel: "manual",
        delayAfterPriorMs: 0,
        templateRef: null,
        gateConditionJson: {},
        tier: "T2",
        autoApprove: false,
      },
    });
    expect(result.kind).toBe("skipped");
    expect(result.skipReason).toBe("manual_or_unknown_channel");
    expect(deps.approvals.create).not.toHaveBeenCalled();
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
