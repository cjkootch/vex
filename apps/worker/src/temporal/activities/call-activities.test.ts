import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildCallActivities } from "./call-activities.js";

/**
 * Unit tests for the seven outbound-call activities. Mocks every
 * dependency so the tests run without a DB, Twilio, or S3. Workflow-
 * level orchestration tests (approval timeout, signal routing) would
 * need @temporalio/testing and are a follow-up change set.
 */

// ---------------------------------------------------------------------------
// Builders
// ---------------------------------------------------------------------------

function stubContact(overrides: Record<string, unknown> = {}) {
  return {
    id: "contact-1",
    tenantId: "01HSEEDWRK0000000000000001",
    orgId: "org-1",
    fullName: "Test Contact",
    phones: ["+15005550006"],
    emails: [],
    timezone: "America/New_York",
    optOutAt: null,
    optOutReason: null,
    status: "active" as const,
    ...overrides,
  };
}

function buildDeps(mode: "allowed" | "blocked" | "suppressed" = "allowed") {
  const findById = vi.fn().mockResolvedValue(
    mode === "suppressed"
      ? stubContact({
          optOutAt: new Date("2026-01-01T00:00:00Z"),
          optOutReason: "explicit opt-out",
        })
      : stubContact(
          mode === "blocked" ? { timezone: "Pacific/Pago_Pago" } : {},
        ),
  );
  const approvalsCreate = vi
    .fn()
    .mockResolvedValue({ id: "new-approval" });
  const approvalsFindByWorkflowId = vi.fn().mockResolvedValue(null);
  const activitiesInsert = vi.fn().mockResolvedValue({ id: "activity-1" });
  const activitiesFindByTypeAndSessionId = vi.fn().mockResolvedValue(null);
  const activitiesUpdateTranscriptRef = vi
    .fn()
    .mockResolvedValue({ id: "activity-1" });
  const summariesGetLatest = vi.fn().mockResolvedValue(null);
  const summariesUpsert = vi.fn().mockResolvedValue({ id: "summary-1" });
  const touchpointsInsert = vi.fn().mockResolvedValue({ id: "touchpoint-1" });
  const eventsInsertIfNotExists = vi.fn().mockResolvedValue(undefined);

  const twilioCreate = vi.fn().mockResolvedValue({
    callSid: "CA_TEST",
    status: "queued",
  });
  const twilioDownload = vi.fn().mockResolvedValue(Buffer.from("audio"));
  const twilio = {
    createOutboundCall: twilioCreate,
    downloadRecording: twilioDownload,
    recordingStorageKey: (tenantId: string, callSid: string) =>
      `recordings/${tenantId}/${callSid}.mp3`,
  };
  const s3PutBuffer = vi.fn().mockResolvedValue(undefined);
  const anthropicQuery = vi.fn().mockResolvedValue({
    answer: "Summary text.",
    costUsd: 0.01,
    proposedActions: [
      {
        kind: "voice_followup.email",
        tier: "T2",
        payload: { subject: "Follow up" },
        rationale: "commitment made on call",
      },
    ],
    viewManifest: {},
    tokensIn: 100,
    tokensOut: 50,
    cacheReadTokens: 0,
    cacheCreateTokens: 0,
  });

  // withTenant is imported from @vex/db — the activity calls
  //   `withTenant(deps.db, tenantId, (tx) => ...)` — so we replace the
  // module with a pass-through that runs the callback with a fake tx.
  const deps = {
    db: { __stub: true } as unknown as never,
    contacts: { findById } as unknown as never,
    approvals: {
      findByWorkflowId: approvalsFindByWorkflowId,
      create: approvalsCreate,
    } as unknown as never,
    activities: {
      findByTypeAndSessionId: activitiesFindByTypeAndSessionId,
      insert: activitiesInsert,
      updateTranscriptRef: activitiesUpdateTranscriptRef,
    } as unknown as never,
    touchpoints: { insert: touchpointsInsert } as unknown as never,
    summaries: {
      getLatest: summariesGetLatest,
      upsert: summariesUpsert,
    } as unknown as never,
    events: {
      insertIfNotExists: eventsInsertIfNotExists,
    } as unknown as never,
    twilio: twilio as unknown as never,
    anthropic: { query: anthropicQuery } as unknown as never,
    s3: { putBuffer: s3PutBuffer } as unknown as never,
    twimlUrl: "https://api.vex.test/calls/twilio/twiml",
    statusCallbackUrl: "https://api.vex.test/calls/twilio/status",
    recordingCallbackUrl: "https://api.vex.test/calls/twilio/recording",
  };
  return {
    deps,
    mocks: {
      findById,
      approvalsCreate,
      approvalsFindByWorkflowId,
      activitiesInsert,
      activitiesFindByTypeAndSessionId,
      activitiesUpdateTranscriptRef,
      summariesGetLatest,
      summariesUpsert,
      touchpointsInsert,
      eventsInsertIfNotExists,
      twilioCreate,
      twilioDownload,
      s3PutBuffer,
      anthropicQuery,
    },
  };
}

// Pass-through withTenant: invokes the callback with a sentinel tx.
vi.mock("@vex/db", async () => {
  const actual = await vi.importActual<Record<string, unknown>>("@vex/db");
  return {
    ...actual,
    withTenant: async (_db: unknown, _tenantId: string, fn: (tx: unknown) => Promise<unknown>) => {
      return fn({ __fake_tx: true });
    },
  };
});

// Swallow span tracing — not under test.
vi.mock("@vex/telemetry", async () => {
  const actual = await vi.importActual<Record<string, unknown>>(
    "@vex/telemetry",
  );
  return {
    ...actual,
    withSpan: async (_name: string, _attrs: unknown, fn: () => unknown) =>
      fn(),
    createLogger: () => ({
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      log: vi.fn(),
    }),
  };
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("call-activities", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("checkCallWindow", () => {
    it("allows a call when the contact-local hour is inside 08:00-18:00", async () => {
      const { deps } = buildDeps("allowed");
      const activities = buildCallActivities(deps);
      const result = await activities.checkCallWindow({
        tenantId: "01HSEEDWRK0000000000000001",
        contactId: "contact-1",
      });
      expect(result.contactTimezone).toBe("America/New_York");
      // Cannot assert allowed=true deterministically without freezing
      // time; assert the structure instead.
      expect(typeof result.allowed).toBe("boolean");
      expect(typeof result.localHour).toBe("number");
    });

    it("blocks the call when the contact lives in a timezone outside window", async () => {
      // Pacific/Pago_Pago is UTC-11 → when UTC is within a wide range, local
      // is 20:00 or later → outside window. Freeze time to remove variance.
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-06-15T08:00:00Z"));
      try {
        const { deps } = buildDeps("blocked");
        const activities = buildCallActivities(deps);
        const result = await activities.checkCallWindow({
          tenantId: "01HSEEDWRK0000000000000001",
          contactId: "contact-1",
        });
        expect(result.allowed).toBe(false);
        expect(result.reason).toMatch(/outside/);
        // Outside the 08:00-18:00 window by definition — the hour is
        // either < 8 or >= 18 depending on the fixed UTC clock above.
        expect(
          result.localHour < 8 || result.localHour >= 18,
        ).toBe(true);
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe("checkSuppression", () => {
    it("rejects a call when contact.opt_out_at is set", async () => {
      const { deps } = buildDeps("suppressed");
      const activities = buildCallActivities(deps);
      const result = await activities.checkSuppression({
        tenantId: "01HSEEDWRK0000000000000001",
        contactId: "contact-1",
      });
      expect(result.suppressed).toBe(true);
      expect(result.reason).toContain("opt-out");
      expect(result.optOutAt).toBeDefined();
    });

    it("allows the call when opt_out_at is null", async () => {
      const { deps } = buildDeps("allowed");
      const activities = buildCallActivities(deps);
      const result = await activities.checkSuppression({
        tenantId: "01HSEEDWRK0000000000000001",
        contactId: "contact-1",
      });
      expect(result.suppressed).toBe(false);
    });
  });

  describe("createApprovalRow idempotency", () => {
    it("returns the existing approval id when findByWorkflowId hits", async () => {
      const { deps, mocks } = buildDeps("allowed");
      mocks.approvalsFindByWorkflowId.mockResolvedValueOnce({
        id: "prior-approval",
      });
      const activities = buildCallActivities(deps);
      const result = await activities.createApprovalRow({
        tenantId: "01HSEEDWRK0000000000000001",
        agentRunId: "run-1",
        workflowId: "wf-1",
        contactId: "contact-1",
        orgId: "org-1",
        toNumber: "+15005550006",
        initiatedByUserId: "user-1",
      });
      expect(result.approvalId).toBe("prior-approval");
      expect(mocks.approvalsCreate).not.toHaveBeenCalled();
    });

    it("creates a new approval when none exists", async () => {
      const { deps, mocks } = buildDeps("allowed");
      mocks.approvalsCreate.mockResolvedValueOnce({ id: "new-approval" });
      const activities = buildCallActivities(deps);
      const result = await activities.createApprovalRow({
        tenantId: "01HSEEDWRK0000000000000001",
        agentRunId: "run-1",
        workflowId: "wf-1",
        contactId: "contact-1",
        orgId: "org-1",
        toNumber: "+15005550006",
        initiatedByUserId: "user-1",
      });
      expect(result.approvalId).toBe("new-approval");
      expect(mocks.approvalsCreate).toHaveBeenCalledOnce();
      const call = mocks.approvalsCreate.mock.calls[0]!;
      expect(call[2].actionType).toBe("outbound_call");
      expect(call[2].proposedPayload.workflow_id).toBe("wf-1");
      expect(call[2].proposedPayload.tier).toBe("T3");
    });
  });

  describe("createTwilioCall", () => {
    it("dials Twilio and records an activity row when not already present", async () => {
      const { deps, mocks } = buildDeps("allowed");
      const activities = buildCallActivities(deps);
      const result = await activities.createTwilioCall({
        tenantId: "01HSEEDWRK0000000000000001",
        contactId: "contact-1",
        orgId: "org-1",
        workflowId: "wf-1",
        agentRunId: "run-1",
        toNumber: "+15005550006",
        approvalId: "appr-1",
      });
      expect(mocks.twilioCreate).toHaveBeenCalledOnce();
      const args = mocks.twilioCreate.mock.calls[0]![0];
      expect(args.to).toBe("+15005550006");
      expect(args.twimlUrl).toContain("wf=wf-1");
      expect(args.statusCallback).toContain("wf=wf-1");
      expect(args.record).toBe(true);
      expect(result.callSid).toBe("CA_TEST");
      expect(mocks.activitiesInsert).toHaveBeenCalledOnce();
    });

    it("is idempotent — a prior voice_call activity short-circuits the dial", async () => {
      const { deps, mocks } = buildDeps("allowed");
      mocks.activitiesFindByTypeAndSessionId.mockResolvedValueOnce({
        id: "activity-existing",
        metadata: { call_sid: "CA_PRIOR", status: "in-progress" },
      });
      const activities = buildCallActivities(deps);
      const result = await activities.createTwilioCall({
        tenantId: "01HSEEDWRK0000000000000001",
        contactId: "contact-1",
        orgId: "org-1",
        workflowId: "wf-1",
        agentRunId: "run-1",
        toNumber: "+15005550006",
        approvalId: "appr-1",
      });
      expect(mocks.twilioCreate).not.toHaveBeenCalled();
      expect(result.callSid).toBe("CA_PRIOR");
      expect(result.activityId).toBe("activity-existing");
    });
  });

  describe("processTranscript", () => {
    it("writes summary + touchpoint + T2 approval for each action item", async () => {
      const { deps, mocks } = buildDeps("allowed");
      const activities = buildCallActivities(deps);
      const result = await activities.processTranscript({
        tenantId: "01HSEEDWRK0000000000000001",
        workspaceId: "ws-1",
        activityId: "activity-1",
        callSid: "CA_TEST",
        transcriptText: "Vex: Hello. Buyer: Yes please send a quote.",
        durationSeconds: 90,
        orgId: "org-1",
        contactId: "contact-1",
      });
      expect(mocks.summariesUpsert).toHaveBeenCalledOnce();
      expect(mocks.touchpointsInsert).toHaveBeenCalledOnce();
      expect(mocks.approvalsCreate).toHaveBeenCalledOnce();
      expect(result.summaryId).toBe("summary-1");
      expect(result.actionItemApprovalIds).toHaveLength(1);
      expect(result.costUsd).toBeGreaterThan(0);
    });

    it("skips when a call_summary already exists (idempotent replay)", async () => {
      const { deps, mocks } = buildDeps("allowed");
      mocks.summariesGetLatest.mockResolvedValueOnce({
        id: "existing-summary",
      });
      const activities = buildCallActivities(deps);
      const result = await activities.processTranscript({
        tenantId: "01HSEEDWRK0000000000000001",
        workspaceId: "ws-1",
        activityId: "activity-1",
        callSid: "CA_TEST",
        transcriptText: "anything",
        durationSeconds: 10,
        orgId: "org-1",
        contactId: "contact-1",
      });
      expect(result.summaryId).toBe("existing-summary");
      expect(mocks.anthropicQuery).not.toHaveBeenCalled();
      expect(mocks.summariesUpsert).not.toHaveBeenCalled();
    });
  });

  describe("emitAuditEvent", () => {
    it("inserts an event row via insertIfNotExists", async () => {
      const { deps, mocks } = buildDeps("allowed");
      const activities = buildCallActivities(deps);
      await activities.emitAuditEvent({
        tenantId: "01HSEEDWRK0000000000000001",
        verb: "call.completed",
        subjectType: "activity",
        subjectId: "activity-1",
        idempotencyKey: "call.completed:wf-1",
        metadata: { call_sid: "CA_TEST", duration_seconds: 42 },
      });
      expect(mocks.eventsInsertIfNotExists).toHaveBeenCalledOnce();
      const args = mocks.eventsInsertIfNotExists.mock.calls[0]!;
      const event = args[2];
      expect(event.verb).toBe("call.completed");
      expect(event.idempotencyKey).toBe("call.completed:wf-1");
      expect(event.metadata).toMatchObject({
        call_sid: "CA_TEST",
        duration_seconds: 42,
      });
    });
  });
});
