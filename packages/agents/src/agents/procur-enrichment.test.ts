import { describe, expect, it, vi } from "vitest";
import { ProcurEnrichmentAgent } from "./procur-enrichment.js";
import type { AgentContext } from "./types.js";
import type {
  ProcurClient,
  SupplierAnalysisResult,
  SupplierProfile,
  SupplierPricingAnalysisResult,
  ProcurResult,
} from "@vex/integrations";

/**
 * Tests use partial-typed AgentContext fixtures. The agent only
 * touches a small slice of the runner-built ctx; the rest is `as
 * never` because exercising the real runner would force a full DB.
 */

const ORG_ID = "01HORG_PROCUR_TEST_000000001";
const TENANT_ID = "01HSEEDWRK0000000000000001";

const BASE_PROFILE: SupplierProfile = {
  kind: "profile",
  supplierId: "procur-supplier-99",
  legalName: "Refidomsa SA",
  country: "DO",
  role: "refiner",
  categories: ["diesel", "gasoline"],
  awardCount: 14,
  awardTotalUsd: 22_000_000,
  recentAwardCount: 6,
  daysSinceLastAward: 12,
  tags: ["caribbean-refiner"],
  distressSignals: [],
  notes: null,
};

interface CapturedWrites {
  tagsAppended: string[];
  fieldConfidenceUpdates: Array<{
    field: string;
    value: unknown;
    source: string;
    confidence: number;
  }>;
  summariesUpserted: Array<{ summaryType: string; content: string }>;
  signalsFired: Array<{
    ruleId: string;
    severity?: string;
    title: string;
    body?: string | null;
  }>;
  snapshotsUpserted: Array<{
    procurTool: string;
    payloadKind: unknown;
  }>;
}

function makeContext(overrides: {
  org: { id: string; legalName: string; kind?: string } | null;
  procur?: ProcurClient;
  fresh?: { payload: Record<string, unknown> } | null;
  any?: { payload: Record<string, unknown> } | null;
}): { ctx: AgentContext; writes: CapturedWrites } {
  const writes: CapturedWrites = {
    tagsAppended: [],
    fieldConfidenceUpdates: [],
    summariesUpserted: [],
    signalsFired: [],
    snapshotsUpserted: [],
  };

  const procur: ProcurClient = overrides.procur ?? {
    isEnabled: () => false,
  } as ProcurClient;

  const ctx = {
    tenantId: TENANT_ID,
    workspaceId: TENANT_ID,
    agentRunId: "01HRUN_TEST",
    tx: { __fake: true } as never,
    procur,
    procurCacheTtlDays: 7,
    organizations: {
      findById: vi.fn(async () => overrides.org),
      appendTag: vi.fn(async (_tx: unknown, _id: string, tag: string) => {
        writes.tagsAppended.push(tag);
        return overrides.org;
      }),
      updateFieldConfidence: vi.fn(
        async (
          _tx: unknown,
          _id: string,
          field: string,
          value: unknown,
          source: string,
          confidence: number,
        ) => {
          writes.fieldConfidenceUpdates.push({
            field,
            value,
            source,
            confidence,
          });
          return overrides.org;
        },
      ),
    } as never,
    procurSnapshots: {
      findFresh: vi.fn(async () => overrides.fresh ?? null),
      findAny: vi.fn(async () => overrides.any ?? null),
      upsert: vi.fn(
        async (
          _tx: unknown,
          _tenantId: string,
          input: { procurTool: string; payload: Record<string, unknown> },
        ) => {
          writes.snapshotsUpserted.push({
            procurTool: input.procurTool,
            payloadKind: input.payload["kind"],
          });
          return { id: "snap" };
        },
      ),
    } as never,
    summaries: {
      upsert: vi.fn(
        async (
          _tx: unknown,
          _tenantId: string,
          input: { summaryType: string; content: string },
        ) => {
          writes.summariesUpserted.push({
            summaryType: input.summaryType,
            content: input.content,
          });
          return { id: "sum" };
        },
      ),
    } as never,
    signals: {
      fire: vi.fn(
        async (
          _tx: unknown,
          _tenantId: string,
          input: {
            ruleId: string;
            severity?: string;
            title: string;
            body?: string | null;
          },
        ) => {
          writes.signalsFired.push(input);
          return { id: "sig" };
        },
      ),
    } as never,
  } as unknown as AgentContext;

  return { ctx, writes };
}

function makeProcurOk<T>(data: T): ProcurResult<T> {
  return { ok: true, data };
}
function makeProcurErr(
  reason: "disabled" | "timeout" | "http_error" | "exception" | "not_found",
): ProcurResult<never> {
  return { ok: false, reason };
}

describe("ProcurEnrichmentAgent", () => {
  it("skips when org is missing", async () => {
    const { ctx } = makeContext({ org: null });
    const agent = new ProcurEnrichmentAgent({ organizationId: ORG_ID });
    const out = await agent.run(ctx);
    expect(out.outputRefs).toMatchObject({ skipped: "org_not_found" });
    expect(out.internalWrites).toBe(0);
  });

  it("skips when procur is disabled (no env)", async () => {
    const { ctx, writes } = makeContext({
      org: { id: ORG_ID, legalName: "Refidomsa" },
      procur: { isEnabled: () => false } as ProcurClient,
    });
    const agent = new ProcurEnrichmentAgent({ organizationId: ORG_ID });
    const out = await agent.run(ctx);
    expect(out.outputRefs).toMatchObject({ skipped: "procur_disabled" });
    expect(out.internalWrites).toBe(0);
    expect(writes.snapshotsUpserted).toHaveLength(0);
  });

  it("uses a fresh cached profile and skips the procur call", async () => {
    const procur: ProcurClient = {
      isEnabled: () => true,
      analyzeSupplier: vi.fn(),
      analyzeSupplierPricing: vi.fn(async () =>
        makeProcurOk<SupplierPricingAnalysisResult>({
          supplierId: "s",
          avgDeltaPct: 22,
          medianDeltaPct: null,
          stddevDeltaPct: null,
          sampleSize: 14,
          byCategory: [],
        }),
      ),
    } as never;
    const { ctx, writes } = makeContext({
      org: { id: ORG_ID, legalName: "Refidomsa" },
      procur,
      fresh: { payload: BASE_PROFILE as unknown as Record<string, unknown> },
    });
    const agent = new ProcurEnrichmentAgent({ organizationId: ORG_ID });
    await agent.run(ctx);
    // analyzeSupplier was NOT called (cache hit)
    expect(procur.analyzeSupplier).not.toHaveBeenCalled();
    // Tags + summary still get written from cached profile
    expect(writes.tagsAppended).toContain("procur:tracked");
    expect(writes.summariesUpserted[0]?.summaryType).toBe(
      "procur_intelligence_brief",
    );
    expect(writes.summariesUpserted[0]?.content).toContain("cached snapshot");
  });

  it("force=true skips the cache and calls procur", async () => {
    const profileResult = makeProcurOk<SupplierAnalysisResult>(BASE_PROFILE);
    const procur: ProcurClient = {
      isEnabled: () => true,
      analyzeSupplier: vi.fn(async () => profileResult),
      analyzeSupplierPricing: vi.fn(async () =>
        makeProcurErr("disabled"),
      ),
    } as never;
    const { ctx } = makeContext({
      org: { id: ORG_ID, legalName: "Refidomsa" },
      procur,
      fresh: { payload: BASE_PROFILE as unknown as Record<string, unknown> },
    });
    const agent = new ProcurEnrichmentAgent({
      organizationId: ORG_ID,
      force: true,
    });
    await agent.run(ctx);
    expect(procur.analyzeSupplier).toHaveBeenCalledOnce();
  });

  it("happy path: writes tags, fieldConfidence, summary, snapshot", async () => {
    const procur: ProcurClient = {
      isEnabled: () => true,
      analyzeSupplier: vi.fn(async () =>
        makeProcurOk<SupplierAnalysisResult>(BASE_PROFILE),
      ),
      analyzeSupplierPricing: vi.fn(async () =>
        makeProcurOk<SupplierPricingAnalysisResult>({
          supplierId: "s",
          avgDeltaPct: 22,
          medianDeltaPct: 21,
          stddevDeltaPct: 6,
          sampleSize: 14,
          byCategory: [{ categoryTag: "diesel", avgDeltaPct: 22, sampleSize: 10 }],
        }),
      ),
    } as never;
    const { ctx, writes } = makeContext({
      org: { id: ORG_ID, legalName: "Refidomsa", kind: "supplier" },
      procur,
    });
    const out = await new ProcurEnrichmentAgent({
      organizationId: ORG_ID,
    }).run(ctx);

    expect(writes.tagsAppended).toContain("procur:tracked");
    expect(writes.tagsAppended).toContain("procur:refiner");
    expect(writes.tagsAppended).toContain("procur:high_award_velocity");
    expect(writes.tagsAppended).toContain("procur:caribbean-refiner");
    expect(writes.fieldConfidenceUpdates.map((u) => u.field)).toEqual(
      expect.arrayContaining(["country", "kind"]),
    );
    expect(writes.summariesUpserted).toHaveLength(1);
    expect(writes.snapshotsUpserted).toHaveLength(2); // analyze + pricing
    expect(writes.snapshotsUpserted[0]?.procurTool).toBe("analyze_supplier");
    expect(writes.snapshotsUpserted[1]?.procurTool).toBe(
      "analyze_supplier_pricing",
    );
    expect(out.outputRefs).toMatchObject({
      procur_status: "profile",
      from_cache: false,
      pricing_fetched: true,
    });
  });

  it("raises a signal on disambiguation_needed and exits without summary", async () => {
    const procur: ProcurClient = {
      isEnabled: () => true,
      analyzeSupplier: vi.fn(async () =>
        makeProcurOk<SupplierAnalysisResult>({
          kind: "disambiguation_needed",
          candidates: [
            { supplierId: "a", legalName: "Refidomsa SA", country: "DO", awardCount: 14 },
            { supplierId: "b", legalName: "Refidomsa LLC", country: "US", awardCount: 3 },
          ],
        }),
      ),
    } as never;
    const { ctx, writes } = makeContext({
      org: { id: ORG_ID, legalName: "Refidomsa" },
      procur,
    });
    const out = await new ProcurEnrichmentAgent({
      organizationId: ORG_ID,
    }).run(ctx);
    expect(writes.signalsFired).toHaveLength(1);
    expect(writes.signalsFired[0]?.ruleId).toBe("procur.disambiguation_needed");
    expect(writes.summariesUpserted).toHaveLength(0);
    expect(out.outputRefs).toMatchObject({
      procur_status: "disambiguation_needed",
      candidates: 2,
    });
  });

  it("tags org procur:not_in_database on not_found and exits", async () => {
    const procur: ProcurClient = {
      isEnabled: () => true,
      analyzeSupplier: vi.fn(async () =>
        makeProcurOk<SupplierAnalysisResult>({
          kind: "not_found",
          searched: "Refidomsa",
        }),
      ),
    } as never;
    const { ctx, writes } = makeContext({
      org: { id: ORG_ID, legalName: "Refidomsa" },
      procur,
    });
    await new ProcurEnrichmentAgent({ organizationId: ORG_ID }).run(ctx);
    expect(writes.tagsAppended).toContain("procur:not_in_database");
    expect(writes.summariesUpserted).toHaveLength(0);
  });

  it("falls back to a stale snapshot when procur is unreachable", async () => {
    const procur: ProcurClient = {
      isEnabled: () => true,
      analyzeSupplier: vi.fn(async () => makeProcurErr("timeout")),
      analyzeSupplierPricing: vi.fn(async () => makeProcurErr("timeout")),
    } as never;
    const stalePayload = BASE_PROFILE as unknown as Record<string, unknown>;
    const { ctx, writes } = makeContext({
      org: { id: ORG_ID, legalName: "Refidomsa" },
      procur,
      fresh: null,
      any: { payload: stalePayload },
    });
    const out = await new ProcurEnrichmentAgent({
      organizationId: ORG_ID,
    }).run(ctx);
    expect(writes.summariesUpserted[0]?.content).toContain("cached snapshot");
    expect(writes.tagsAppended).toContain("procur:tracked");
    expect(out.outputRefs).toMatchObject({
      from_cache: true,
      procur_status: "profile",
    });
  });

  it("returns no_data when procur fails AND no stale snapshot exists", async () => {
    const procur: ProcurClient = {
      isEnabled: () => true,
      analyzeSupplier: vi.fn(async () => makeProcurErr("http_error")),
    } as never;
    const { ctx, writes } = makeContext({
      org: { id: ORG_ID, legalName: "Refidomsa" },
      procur,
      fresh: null,
      any: null,
    });
    const out = await new ProcurEnrichmentAgent({
      organizationId: ORG_ID,
    }).run(ctx);
    expect(out.outputRefs).toMatchObject({ procur_status: "http_error" });
    expect(writes.summariesUpserted).toHaveLength(0);
    expect(writes.tagsAppended).toHaveLength(0);
  });

  it("raises a signal for each distress signal in the profile", async () => {
    const profileWithDistress: SupplierProfile = {
      ...BASE_PROFILE,
      distressSignals: [
        {
          kind: "award_velocity_drop",
          detail: "Lost 60% of recurring DR awards over the last 90 days",
          observedAt: "2026-04-15",
        },
        {
          kind: "leadership_change",
          detail: "CFO departure announced 2026-03-20",
          observedAt: "2026-03-20",
        },
      ],
    };
    const procur: ProcurClient = {
      isEnabled: () => true,
      analyzeSupplier: vi.fn(async () =>
        makeProcurOk<SupplierAnalysisResult>(profileWithDistress),
      ),
      analyzeSupplierPricing: vi.fn(async () => makeProcurErr("disabled")),
    } as never;
    const { ctx, writes } = makeContext({
      org: { id: ORG_ID, legalName: "Refidomsa", kind: "supplier" },
      procur,
    });
    await new ProcurEnrichmentAgent({ organizationId: ORG_ID }).run(ctx);
    expect(writes.signalsFired).toHaveLength(2);
    expect(writes.signalsFired.map((s) => s.ruleId)).toEqual([
      "procur.distress.award_velocity_drop",
      "procur.distress.leadership_change",
    ]);
  });
});
