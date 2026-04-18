import { describe, expect, it } from "vitest";
import type { Tx } from "../client.js";
import { CampaignStepRepository } from "./campaign-step-repository.js";
import { CampaignEnrollmentRepository } from "./campaign-enrollment-repository.js";

/**
 * Minimal fake Tx — matches the pattern used by repositories.test.ts.
 * The chain returns `this` until awaited; `await` resolves to the
 * configured rows. Keeps these tests pure — no live Postgres needed.
 */
interface StubResponses {
  select?: unknown[];
  returning?: unknown[];
}

function fakeTx(responses: StubResponses): Tx {
  const thenable = (rows: unknown[]) => {
    const chain = {
      from: () => chain,
      where: () => chain,
      orderBy: () => chain,
      limit: () => chain,
      leftJoin: () => chain,
      innerJoin: () => chain,
      then: (resolve: (rows: unknown[]) => void) => resolve(rows),
    };
    return chain;
  };

  const updateChain = {
    set: () => updateChain,
    where: () => updateChain,
    returning: () => Promise.resolve(responses.returning ?? []),
    then: (resolve: (r: unknown[]) => void) => resolve([]),
  };

  const insertChain = {
    values: () => insertChain,
    returning: () => Promise.resolve(responses.returning ?? []),
    then: (resolve: (r: unknown[]) => void) => resolve([]),
  };

  const deleteChain = {
    where: () => deleteChain,
    then: (resolve: (r: unknown[]) => void) => resolve([]),
  };

  return {
    select: () => thenable(responses.select ?? []),
    update: () => updateChain,
    insert: () => insertChain,
    delete: () => deleteChain,
  } as unknown as Tx;
}

describe("CampaignStepRepository", () => {
  it("create mints an id and defaults tier=T2, autoApprove=false, delay=0", async () => {
    const repo = new CampaignStepRepository();
    const tx = fakeTx({
      returning: [
        {
          id: "x",
          tenantId: "t",
          campaignId: "c",
          position: 0,
          channel: "email",
          delayAfterPriorMs: 0,
          templateRef: null,
          gateConditionJson: {},
          tier: "T2",
          autoApprove: false,
        },
      ],
    });
    const step = await repo.create(tx, "t", {
      campaignId: "c",
      position: 0,
      channel: "email",
    });
    expect(step.tier).toBe("T2");
    expect(step.autoApprove).toBe(false);
    expect(step.delayAfterPriorMs).toBe(0);
  });

  it("validateSequence passes when positions are 0..N-1", async () => {
    const repo = new CampaignStepRepository();
    const tx = fakeTx({
      select: [
        { position: 0 },
        { position: 1 },
        { position: 2 },
      ],
    });
    expect(await repo.validateSequence(tx, "c")).toBeNull();
  });

  it("validateSequence reports a gap", async () => {
    const repo = new CampaignStepRepository();
    const tx = fakeTx({ select: [{ position: 0 }, { position: 2 }] });
    expect(await repo.validateSequence(tx, "c")).toMatch(/position gap at step 1/);
  });

  it("validateSequence reports an empty plan", async () => {
    const repo = new CampaignStepRepository();
    const tx = fakeTx({ select: [] });
    expect(await repo.validateSequence(tx, "c")).toBe("plan has no steps");
  });
});

describe("CampaignEnrollmentRepository", () => {
  it("enroll returns alreadyEnrolled=true when a matching row exists", async () => {
    const repo = new CampaignEnrollmentRepository();
    const existing = {
      id: "e1",
      tenantId: "t",
      campaignId: "c",
      contactId: "ct1",
      currentStep: 3,
      state: "paused",
      lastEventAt: null,
      branchHistoryJson: [],
      error: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    const tx = fakeTx({ select: [existing] });
    const result = await repo.enroll(tx, "t", {
      campaignId: "c",
      contactId: "ct1",
    });
    expect(result.alreadyEnrolled).toBe(true);
    expect(result.enrollment.id).toBe("e1");
  });

  it("enroll inserts a fresh row when none exists", async () => {
    const repo = new CampaignEnrollmentRepository();
    const fresh = {
      id: "e2",
      tenantId: "t",
      campaignId: "c",
      contactId: "ct2",
      currentStep: 0,
      state: "enrolled",
      lastEventAt: null,
      branchHistoryJson: [],
      error: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    // select returns empty → findByContactAndCampaign == null → insert path
    const tx = fakeTx({ select: [], returning: [fresh] });
    const result = await repo.enroll(tx, "t", {
      campaignId: "c",
      contactId: "ct2",
    });
    expect(result.alreadyEnrolled).toBe(false);
    expect(result.enrollment.state).toBe("enrolled");
    expect(result.enrollment.currentStep).toBe(0);
  });

  it("countByState buckets rows by enrollment state", async () => {
    const repo = new CampaignEnrollmentRepository();
    const tx = fakeTx({
      select: [
        { state: "enrolled" },
        { state: "enrolled" },
        { state: "completed" },
        { state: "paused" },
      ],
    });
    const counts = await repo.countByState(tx, "c");
    expect(counts["enrolled"]).toBe(2);
    expect(counts["completed"]).toBe(1);
    expect(counts["paused"]).toBe(1);
  });
});
