import {
  ForbiddenException,
  NotFoundException,
  BadRequestException,
  ServiceUnavailableException,
} from "@nestjs/common";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { CallsService, OUTBOUND_CALL_AGENT_NAME } from "./calls.service.js";

/**
 * Unit tests for CallsService. Mocks every dep — we're proving the
 * guardrails (T3 enabled, contact exists, phone on file) and the
 * agent-run + approval creation sequence, not the Temporal plumbing.
 */

const TENANT = "01HSEEDWRK0000000000000001";
const WORKSPACE = TENANT;

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

function buildService(overrides: {
  enabled?: string[];
  contact?: unknown | null;
} = {}) {
  const workspace = {
    id: WORKSPACE,
    settings: {
      enabled_agents: overrides.enabled ?? [OUTBOUND_CALL_AGENT_NAME],
    },
  };
  const workspacesFindById = vi.fn().mockResolvedValue(workspace);

  const defaultContact = {
    id: "contact-1",
    orgId: "org-1",
    phones: ["+15005550006"],
    timezone: "UTC",
    optOutAt: null,
  };
  const contact =
    overrides.contact === undefined ? defaultContact : overrides.contact;
  const contactsFindById = vi.fn().mockResolvedValue(contact);

  const agentRunsCreate = vi
    .fn()
    .mockResolvedValue({ id: "01HRUN0000000000000000000A" });
  const approvalsCreate = vi
    .fn()
    .mockResolvedValue({ id: "01HAPP0000000000000000000A" });
  const eventsInsertIfNotExists = vi.fn().mockResolvedValue(undefined);

  const workflowStart = vi.fn().mockResolvedValue(undefined);
  const temporal = { workflow: { start: workflowStart, getHandle: vi.fn() } };

  const service = new CallsService(
    {} as never, // db
    { findById: workspacesFindById } as never, // workspaces
    { findById: contactsFindById } as never, // contacts
    { create: agentRunsCreate } as never, // agentRuns
    { create: approvalsCreate, findByWorkflowId: vi.fn() } as never, // approvals
    {} as never, // activities
    {} as never, // summaries
    { insertIfNotExists: eventsInsertIfNotExists } as never, // events
    temporal as never, // temporal
    {} as never, // twilio
    {} as never, // s3
    "vex-main", // taskQueue
    null, // voiceSdk
    "", // appBaseUrl
    { insert: () => ({ id: "01HSTUBTP0" }) } as never, // touchpoints
    null, // resend
    null, // redis
  );

  return {
    service,
    mocks: {
      workspacesFindById,
      contactsFindById,
      agentRunsCreate,
      approvalsCreate,
      eventsInsertIfNotExists,
      workflowStart,
    },
  };
}

describe("CallsService.initiateCall", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("rejects with 403 when outbound_call is not in workspace.enabled_agents", async () => {
    const { service, mocks } = buildService({ enabled: ["daily_brief"] });
    await expect(
      service.initiateCall({
        tenantId: TENANT,
        workspaceId: WORKSPACE,
        contactId: "contact-1",
        initiatedByUserId: "user-1",
      }),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(mocks.contactsFindById).not.toHaveBeenCalled();
    expect(mocks.workflowStart).not.toHaveBeenCalled();
  });

  it("rejects with 404 when the contact does not exist", async () => {
    const { service } = buildService({ contact: null });
    await expect(
      service.initiateCall({
        tenantId: TENANT,
        workspaceId: WORKSPACE,
        contactId: "contact-missing",
        initiatedByUserId: "user-1",
      }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it("rejects with 400 when the contact has no phone number", async () => {
    const { service, mocks } = buildService({
      contact: {
        id: "contact-1",
        orgId: "org-1",
        phones: [],
      },
    });
    await expect(
      service.initiateCall({
        tenantId: TENANT,
        workspaceId: WORKSPACE,
        contactId: "contact-1",
        initiatedByUserId: "user-1",
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(mocks.workflowStart).not.toHaveBeenCalled();
  });

  it("creates an agent_run + T3 approval + starts the workflow on the happy path", async () => {
    const { service, mocks } = buildService();
    const result = await service.initiateCall({
      tenantId: TENANT,
      workspaceId: WORKSPACE,
      contactId: "contact-1",
      initiatedByUserId: "user-1",
    });

    expect(result.status).toBe("pending_approval");
    expect(result.workflowId).toMatch(/^outbound-call-/);
    expect(result.approvalId).toMatch(/^01HAPP/);

    expect(mocks.agentRunsCreate).toHaveBeenCalledOnce();
    const runArgs = mocks.agentRunsCreate.mock.calls[0]!;
    expect(runArgs[2].agentName).toBe(OUTBOUND_CALL_AGENT_NAME);

    expect(mocks.approvalsCreate).toHaveBeenCalledOnce();
    const approvalArgs = mocks.approvalsCreate.mock.calls[0]!;
    expect(approvalArgs[2].actionType).toBe("outbound_call");
    expect(approvalArgs[2].proposedPayload.tier).toBe("T3");
    expect(approvalArgs[2].proposedPayload.workflow_id).toMatch(
      /^outbound-call-/,
    );

    expect(mocks.workflowStart).toHaveBeenCalledOnce();
    const startArgs = mocks.workflowStart.mock.calls[0]!;
    expect(startArgs[0]).toBe("outboundCallWorkflow");
    expect(startArgs[1].workflowId).toBe(result.workflowId);
    expect(startArgs[1].taskQueue).toBe("vex-main");

    expect(mocks.eventsInsertIfNotExists).toHaveBeenCalledOnce();
    const eventArgs = mocks.eventsInsertIfNotExists.mock.calls[0]!;
    expect(eventArgs[2].verb).toBe("call.initiated");
  });
});

describe("CallsService.requestHumanBackup", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  interface BackupFixtureOpts {
    pending?: Array<{
      id: string;
      actionType: string;
      proposedPayload: Record<string, unknown>;
    }>;
    activity?: {
      occurredAt: Date;
      metadata?: Record<string, unknown>;
    } | null;
    callApprovalExists?: boolean;
  }

  function buildBackupService(opts: BackupFixtureOpts = {}) {
    const approvalsCreate = vi
      .fn()
      .mockResolvedValue({ id: "01HAPP_NEW_BACKUP_000000000A" });
    const approvalsFindByWorkflowId = vi
      .fn()
      .mockResolvedValue(
        opts.callApprovalExists === false
          ? null
          : {
              id: "01HAPP_CALL_00000000000000A",
              agentRunId: "01HRUN_00000000000000000000A",
              proposedPayload: { contact_id: "contact-1" },
            },
      );
    const approvalsListByDecision = vi
      .fn()
      .mockResolvedValue(opts.pending ?? []);
    const activitiesFindByTypeAndSessionId = vi
      .fn()
      .mockResolvedValue(opts.activity ?? null);
    const eventsInsertIfNotExists = vi.fn().mockResolvedValue(undefined);

    const service = new CallsService(
      {} as never,
      { findById: vi.fn() } as never,
      { findById: vi.fn() } as never,
      {} as never,
      {
        create: approvalsCreate,
        findByWorkflowId: approvalsFindByWorkflowId,
        listByDecision: approvalsListByDecision,
      } as never,
      { findByTypeAndSessionId: activitiesFindByTypeAndSessionId } as never,
      {} as never,
      { insertIfNotExists: eventsInsertIfNotExists } as never,
      {} as never,
      {} as never,
      {} as never,
      "vex-main",
      null,
      "",
      { insert: () => ({ id: "01HSTUBTP0" }) } as never,
      null,
      null,
    );
    return {
      service,
      mocks: {
        approvalsCreate,
        approvalsFindByWorkflowId,
        approvalsListByDecision,
        activitiesFindByTypeAndSessionId,
        eventsInsertIfNotExists,
      },
    };
  }

  it("creates a T2 approval with duration + callee + call_sid metadata", async () => {
    const startedAt = new Date(Date.now() - 180_000); // 3 minutes ago
    const { service, mocks } = buildBackupService({
      activity: {
        occurredAt: startedAt,
        metadata: { call_sid: "CA_TEST_SID" },
      },
    });
    const result = await service.requestHumanBackup({
      tenantId: TENANT,
      workflowId: "outbound-call-01HRUN_00000000000000000000A",
      reason: "customer asked to speak to a human",
      initiatedBy: "01HSEEDUSR0000000000000001",
    });

    expect(result.existed).toBe(false);
    expect(result.approvalId).toBe("01HAPP_NEW_BACKUP_000000000A");
    const createArgs = mocks.approvalsCreate.mock.calls[0]!;
    const payload = createArgs[2].proposedPayload as Record<string, unknown>;
    expect(createArgs[2].actionType).toBe("call.request_backup");
    expect(payload["tier"]).toBe("T2");
    expect(payload["workflow_id"]).toBe(
      "outbound-call-01HRUN_00000000000000000000A",
    );
    expect(payload["call_sid"]).toBe("CA_TEST_SID");
    expect(payload["callee_contact_id"]).toBe("contact-1");
    expect(payload["reason"]).toBe("customer asked to speak to a human");
    // 3 minutes ago → duration ~180s. Allow a small tolerance for
    // test-runtime drift.
    const duration = payload["duration_at_request_seconds"] as number;
    expect(duration).toBeGreaterThanOrEqual(179);
    expect(duration).toBeLessThanOrEqual(181);

    const event = mocks.eventsInsertIfNotExists.mock.calls[0]![2];
    expect(event.verb).toBe("call.backup_requested");
  });

  it("is idempotent per workflow — a second request for an open call returns the existing approval", async () => {
    const { service, mocks } = buildBackupService({
      pending: [
        {
          id: "01HAPP_PRIOR_00000000000000A",
          actionType: "call.request_backup",
          proposedPayload: {
            workflow_id: "outbound-call-01HRUN_00000000000000000000A",
          },
        },
      ],
    });
    const result = await service.requestHumanBackup({
      tenantId: TENANT,
      workflowId: "outbound-call-01HRUN_00000000000000000000A",
      reason: "second request",
    });
    expect(result.existed).toBe(true);
    expect(result.approvalId).toBe("01HAPP_PRIOR_00000000000000A");
    expect(mocks.approvalsCreate).not.toHaveBeenCalled();
    expect(mocks.eventsInsertIfNotExists).not.toHaveBeenCalled();
  });

  it("throws NotFoundException when the underlying call approval is missing", async () => {
    const { service } = buildBackupService({ callApprovalExists: false });
    await expect(
      service.requestHumanBackup({
        tenantId: TENANT,
        workflowId: "outbound-call-missing",
      }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it("handles calls with no activity yet — duration reports 0", async () => {
    const { service, mocks } = buildBackupService({ activity: null });
    await service.requestHumanBackup({
      tenantId: TENANT,
      workflowId: "outbound-call-01HRUN_00000000000000000000A",
    });
    const payload = mocks.approvalsCreate.mock.calls[0]![2]
      .proposedPayload as Record<string, unknown>;
    expect(payload["call_sid"]).toBeNull();
    expect(payload["duration_at_request_seconds"]).toBe(0);
  });

  it("ignores pending backup requests for OTHER workflows when checking idempotency", async () => {
    const { service, mocks } = buildBackupService({
      pending: [
        {
          id: "01HAPP_OTHER_00000000000000A",
          actionType: "call.request_backup",
          proposedPayload: {
            workflow_id: "outbound-call-different",
          },
        },
      ],
    });
    const result = await service.requestHumanBackup({
      tenantId: TENANT,
      workflowId: "outbound-call-01HRUN_00000000000000000000A",
    });
    expect(result.existed).toBe(false);
    expect(mocks.approvalsCreate).toHaveBeenCalledOnce();
  });

  it("ignores pending approvals of non-backup action types", async () => {
    const { service, mocks } = buildBackupService({
      pending: [
        {
          id: "01HAPP_UNRELATED_00000000A",
          actionType: "follow_up.suggestion",
          proposedPayload: {
            workflow_id: "outbound-call-01HRUN_00000000000000000000A",
          },
        },
      ],
    });
    const result = await service.requestHumanBackup({
      tenantId: TENANT,
      workflowId: "outbound-call-01HRUN_00000000000000000000A",
    });
    expect(result.existed).toBe(false);
    expect(mocks.approvalsCreate).toHaveBeenCalledOnce();
  });
});

describe("CallsService.mintJoinToken", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  interface JoinFixtureOpts {
    voiceSdk?: {
      accountSid: string;
      apiKey: string;
      apiSecret: string;
      twimlAppSid: string;
    } | null;
    approval?: unknown | null;
    activity?: {
      metadata: Record<string, unknown>;
      result: string | null;
    } | null;
  }

  function buildJoinService(opts: JoinFixtureOpts = {}) {
    const voiceSdk =
      opts.voiceSdk === undefined
        ? {
            accountSid: "ACtest",
            apiKey: "SKtest",
            apiSecret: "secret-abcdefghijklmnopqrstuvwxyz012345",
            twimlAppSid: "APtest",
          }
        : opts.voiceSdk;

    const approvalsFindByWorkflowId = vi
      .fn()
      .mockResolvedValue(
        opts.approval === undefined
          ? {
              id: "01HAPP_CALL_00000000000000A",
              agentRunId: "01HRUN_00000000000000000000A",
              proposedPayload: { contact_id: "contact-1" },
            }
          : opts.approval,
      );
    const activitiesFindByTypeAndSessionId = vi
      .fn()
      .mockResolvedValue(opts.activity ?? null);

    const service = new CallsService(
      {} as never,
      { findById: vi.fn() } as never,
      { findById: vi.fn() } as never,
      {} as never,
      {
        create: vi.fn(),
        findByWorkflowId: approvalsFindByWorkflowId,
        listByDecision: vi.fn(),
      } as never,
      { findByTypeAndSessionId: activitiesFindByTypeAndSessionId } as never,
      {} as never,
      { insertIfNotExists: vi.fn() } as never,
      {} as never,
      {} as never,
      {} as never,
      "vex-main",
      voiceSdk,
      "",
      { insert: () => ({ id: "01HSTUBTP0" }) } as never,
      null,
      null,
    );
    return {
      service,
      mocks: { approvalsFindByWorkflowId, activitiesFindByTypeAndSessionId },
    };
  }

  it("throws 503 when Voice SDK env vars aren't configured", async () => {
    const { service } = buildJoinService({ voiceSdk: null });
    await expect(
      service.mintJoinToken({
        tenantId: TENANT,
        workflowId: "outbound-call-01HRUN_00000000000000000000A",
        userId: "user-1",
        conferenceName: "vex-outbound-call-01HRUN_00000000000000000000A",
      }),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
  });

  it("throws 404 when the workflow approval is missing", async () => {
    const { service } = buildJoinService({ approval: null });
    await expect(
      service.mintJoinToken({
        tenantId: TENANT,
        workflowId: "outbound-call-unknown",
        userId: "user-1",
        conferenceName: "vex-outbound-call-unknown",
      }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it("throws 400 when the call activity is already in a terminal state", async () => {
    const { service } = buildJoinService({
      activity: { metadata: { status: "completed" }, result: "completed" },
    });
    await expect(
      service.mintJoinToken({
        tenantId: TENANT,
        workflowId: "outbound-call-01HRUN_00000000000000000000A",
        userId: "user-1",
        conferenceName: "vex-outbound-call-01HRUN_00000000000000000000A",
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it("mints a JWT with the operator identity when the call is live", async () => {
    const { service } = buildJoinService({
      activity: { metadata: { status: "in-progress" }, result: null },
    });
    const result = await service.mintJoinToken({
      tenantId: TENANT,
      workflowId: "outbound-call-01HRUN_00000000000000000000A",
      userId: "01HSEEDUSR0000000000000001",
      conferenceName: "vex-outbound-call-01HRUN_00000000000000000000A",
    });
    expect(result.identity).toBe("operator-01HSEEDUSR0000000000000001");
    expect(result.conferenceName).toBe(
      "vex-outbound-call-01HRUN_00000000000000000000A",
    );
    // JWT sanity — three dot-separated base64 segments.
    expect(result.token.split(".").length).toBe(3);
    expect(Date.parse(result.expiresAt)).toBeGreaterThan(Date.now());
  });

  it("mints a token even when no activity row exists yet (early in the call)", async () => {
    const { service } = buildJoinService({ activity: null });
    const result = await service.mintJoinToken({
      tenantId: TENANT,
      workflowId: "outbound-call-01HRUN_00000000000000000000A",
      userId: "user-1",
      conferenceName: "vex-outbound-call-01HRUN_00000000000000000000A",
    });
    expect(result.token.split(".").length).toBe(3);
  });
});
