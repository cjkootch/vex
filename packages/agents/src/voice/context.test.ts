import { describe, expect, it } from "vitest";
import { VoiceContextBuilder } from "./context.js";
import { countTokens } from "./token-counter.js";
import { DEFAULT_VOICE_TOKEN_BUDGET } from "./types.js";

interface FakeOrg {
  id: string;
  legalName: string;
  industry: string | null;
  fitScore: number | null;
}

interface FakeSummary {
  id: string;
  subjectType: string;
  subjectId: string;
  summaryType: string;
  content: string;
  version: number;
  createdAt: Date;
}

interface FakeApproval {
  id: string;
  decision: string;
  actionType: string;
  proposedPayload: Record<string, unknown>;
}

function makeFakes() {
  const orgs: FakeOrg[] = [
    {
      id: "01HSEEDORG0000000000000001",
      legalName: "Acme Corporation",
      industry: "Manufacturing",
      fitScore: 0.91,
    },
  ];
  const summaries: FakeSummary[] = [];
  const approvals: FakeApproval[] = [];

  const builder = new VoiceContextBuilder({
    organizations: {
      async findById(_tx: unknown, id: string) {
        return (orgs.find((o) => o.id === id) as unknown) ?? null;
      },
    } as never,
    contacts: {
      async findByOrgId(_tx: unknown, _orgId: string) {
        return [] as never[];
      },
    } as never,
    summaries: {
      async getLatest(
        _tx: unknown,
        subjectType: string,
        subjectId: string,
        summaryType: string,
      ) {
        const hits = summaries.filter(
          (s) =>
            s.subjectType === subjectType &&
            s.subjectId === subjectId &&
            s.summaryType === summaryType,
        );
        hits.sort((a, b) => b.version - a.version);
        return (hits[0] as unknown) ?? null;
      },
      async listBySubject(_tx: unknown, subjectType: string, subjectId: string) {
        return summaries.filter(
          (s) => s.subjectType === subjectType && s.subjectId === subjectId,
        ) as unknown as never[];
      },
    } as never,
    touchpoints: {
      async listForOrgSince(
        _tx: unknown,
        _orgId: string,
        _since: Date,
        _limit?: number,
      ) {
        return [] as never[];
      },
    } as never,
    approvals: {
      async listByDecision(_tx: unknown, decision: string, _limit?: number) {
        return approvals.filter((a) => a.decision === decision) as unknown as never[];
      },
    } as never,
  });

  return { builder, orgs, summaries, approvals };
}

describe("VoiceContextBuilder", () => {
  it("assembles a voice context and returns an estimated-tokens count", async () => {
    const fakes = makeFakes();
    fakes.summaries.push({
      id: "01HSEEDSMR0000000000000001",
      subjectType: "organization",
      subjectId: "01HSEEDORG0000000000000001",
      summaryType: "org_brief",
      version: 3,
      content:
        "Acme is a Fortune 1000 manufacturer based in Ohio. Deal stage: SQL.",
      createdAt: new Date("2026-04-15T00:00:00Z"),
    });

    const ctx = await fakes.builder.build({} as never, {
      orgId: "01HSEEDORG0000000000000001",
      contactId: null,
    });

    expect(ctx.orgSummary?.text).toContain("Acme");
    expect(ctx.totalEstimatedTokens).toBeGreaterThan(0);
    expect(ctx.totalEstimatedTokens).toBeLessThan(
      DEFAULT_VOICE_TOKEN_BUDGET.hardMax,
    );
    expect(ctx.truncated).toBe(false);
    expect(countTokens(ctx.orgSummary!.text)).toBeLessThanOrEqual(
      DEFAULT_VOICE_TOKEN_BUDGET.perBlock.orgSummary + 8,
    );
  });

  it("never exceeds hardMax for an adversarial fixture with huge summaries", async () => {
    const fakes = makeFakes();
    const huge = "lorem ipsum dolor sit amet ".repeat(8000);
    fakes.summaries.push({
      id: "01HSEEDSMR0000000000000002",
      subjectType: "organization",
      subjectId: "01HSEEDORG0000000000000001",
      summaryType: "org_brief",
      version: 1,
      content: huge,
      createdAt: new Date(),
    });
    for (let i = 0; i < 3; i += 1) {
      fakes.summaries.push({
        id: `01HSEEDSMR0000000000000${10 + i}`,
        subjectType: "organization",
        subjectId: "01HSEEDORG0000000000000001",
        summaryType: "call_summary",
        version: 1,
        content: `Call #${i}: ${huge}`,
        createdAt: new Date(),
      });
    }

    const ctx = await fakes.builder.build({} as never, {
      orgId: "01HSEEDORG0000000000000001",
      contactId: null,
    });

    expect(ctx.totalEstimatedTokens).toBeLessThanOrEqual(
      DEFAULT_VOICE_TOKEN_BUDGET.hardMax,
    );
  });

  it("returns a minimal context when orgId is null (no data reads)", async () => {
    const fakes = makeFakes();
    const ctx = await fakes.builder.build({} as never, {
      orgId: null,
      contactId: null,
    });
    expect(ctx.orgSummary).toBeNull();
    expect(ctx.recentCalls).toEqual([]);
    expect(ctx.keyContacts).toEqual([]);
    expect(ctx.recentEmailClicks).toEqual([]);
    expect(ctx.totalEstimatedTokens).toBe(0);
  });
});
