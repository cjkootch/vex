import { beforeEach, describe, expect, it, vi } from "vitest";
import { runEnrollmentReconciliationTick } from "./enrollment-reconciliation-job.js";

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

const TENANT = "01HSEEDWRK0000000000000001";

/**
 * Mock a Temporal `handle.describe()` that either resolves
 * (workflow exists) or throws the not-found error we expect to
 * recognise.
 */
function buildHandle(
  outcome: "running" | "not_found" | "other_error" = "running",
) {
  return {
    describe: vi.fn().mockImplementation(async () => {
      if (outcome === "running") return { workflowId: "ok" };
      if (outcome === "not_found") {
        throw new Error("workflow execution not found");
      }
      throw new Error("transient gRPC error");
    }),
  };
}

function buildDeps(opts: {
  candidates: Array<{ id: string; tenantId: string; campaignId: string }>;
  workflowOutcomes: Record<string, "running" | "not_found" | "other_error">;
  now?: () => Date;
}) {
  const handles: Record<string, ReturnType<typeof buildHandle>> = {};
  for (const [wfId, outcome] of Object.entries(opts.workflowOutcomes)) {
    handles[wfId] = buildHandle(outcome);
  }
  return {
    db: {},
    enrollments: {
      listStaleEnrolled: vi.fn().mockResolvedValue(
        opts.candidates.map((c) => ({
          ...c,
          state: "enrolled",
          currentStep: 0,
          branchHistoryJson: [],
          lastEventAt: null,
          error: null,
          createdAt: new Date(),
          updatedAt: new Date(),
        })),
      ),
    },
    events: {
      insertIfNotExists: vi.fn().mockResolvedValue(undefined),
    },
    temporal: {
      workflow: {
        getHandle: (workflowId: string) =>
          handles[workflowId] ?? buildHandle("not_found"),
        start: vi.fn().mockResolvedValue(undefined),
      },
    },
    ...(opts.now ? { now: opts.now } : {}),
  };
}

function asDeps(deps: ReturnType<typeof buildDeps>) {
  return deps as unknown as Parameters<typeof runEnrollmentReconciliationTick>[0];
}

describe("runEnrollmentReconciliationTick", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns all zeros when Temporal is null (no DB query either)", async () => {
    const deps = buildDeps({
      candidates: [{ id: "e1", tenantId: TENANT, campaignId: "c1" }],
      workflowOutcomes: {},
    });
    (deps as { temporal: unknown }).temporal = null;
    const result = await runEnrollmentReconciliationTick(asDeps(deps), {
      tenantId: TENANT,
    });
    expect(result).toEqual({ scanned: 0, healthy: 0, restarted: 0, failures: 0 });
    expect(deps.enrollments.listStaleEnrolled).not.toHaveBeenCalled();
  });

  it("counts running workflows as healthy — no restart", async () => {
    const deps = buildDeps({
      candidates: [{ id: "e1", tenantId: TENANT, campaignId: "c1" }],
      workflowOutcomes: { "campaign-enrollment-e1": "running" },
    });
    const result = await runEnrollmentReconciliationTick(asDeps(deps), {
      tenantId: TENANT,
    });
    expect(result.healthy).toBe(1);
    expect(result.restarted).toBe(0);
    expect(deps.temporal.workflow.start).not.toHaveBeenCalled();
  });

  it("restarts missing workflows + emits a restart event", async () => {
    const deps = buildDeps({
      candidates: [
        { id: "e_missing", tenantId: TENANT, campaignId: "c1" },
        { id: "e_healthy", tenantId: TENANT, campaignId: "c1" },
      ],
      workflowOutcomes: {
        "campaign-enrollment-e_missing": "not_found",
        "campaign-enrollment-e_healthy": "running",
      },
    });
    const result = await runEnrollmentReconciliationTick(asDeps(deps), {
      tenantId: TENANT,
    });
    expect(result.restarted).toBe(1);
    expect(result.healthy).toBe(1);
    expect(result.scanned).toBe(2);
    const starts = (deps.temporal.workflow.start as ReturnType<typeof vi.fn>).mock.calls;
    expect(starts).toHaveLength(1);
    expect(starts[0]![1].workflowId).toBe("campaign-enrollment-e_missing");

    const event = deps.events.insertIfNotExists.mock.calls[0]![2];
    expect(event.verb).toBe("campaign.enrollment_workflow_restarted");
    expect(event.metadata.enrollment_id).toBe("e_missing");
  });

  it("counts 'already started' races as healthy, not failures", async () => {
    const deps = buildDeps({
      candidates: [{ id: "e1", tenantId: TENANT, campaignId: "c1" }],
      workflowOutcomes: { "campaign-enrollment-e1": "not_found" },
    });
    (deps.temporal.workflow.start as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error("WorkflowExecutionAlreadyStarted: campaign-enrollment-e1"),
    );
    const result = await runEnrollmentReconciliationTick(asDeps(deps), {
      tenantId: TENANT,
    });
    expect(result.healthy).toBe(1);
    expect(result.restarted).toBe(0);
    expect(result.failures).toBe(0);
  });

  it("tallies unexpected describe errors as failures (and does not restart)", async () => {
    const deps = buildDeps({
      candidates: [{ id: "e1", tenantId: TENANT, campaignId: "c1" }],
      workflowOutcomes: { "campaign-enrollment-e1": "other_error" },
    });
    const result = await runEnrollmentReconciliationTick(asDeps(deps), {
      tenantId: TENANT,
    });
    expect(result.failures).toBe(1);
    expect(result.restarted).toBe(0);
    expect(deps.temporal.workflow.start).not.toHaveBeenCalled();
  });

  it("uses the staleMinutes threshold to query the repo", async () => {
    const now = new Date("2026-04-18T14:00:00Z");
    const deps = buildDeps({
      candidates: [],
      workflowOutcomes: {},
      now: () => now,
    });
    await runEnrollmentReconciliationTick(asDeps(deps), {
      tenantId: TENANT,
      staleMinutes: 45,
    });
    const [, cutoff, limit] = (deps.enrollments.listStaleEnrolled as ReturnType<typeof vi.fn>).mock.calls[0]!;
    const expected = new Date(now.getTime() - 45 * 60_000);
    expect((cutoff as Date).getTime()).toBe(expected.getTime());
    expect(limit).toBe(50);
  });
});
