import { ForbiddenException, NotFoundException, BadRequestException } from "@nestjs/common";
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
