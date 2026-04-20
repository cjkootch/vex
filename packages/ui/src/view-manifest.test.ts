import { describe, expect, it } from "vitest";
import { manifestFallback, validateManifest } from "./view-manifest.js";

describe("validateManifest", () => {
  it("accepts a manifest with a single table panel", () => {
    const result = validateManifest({
      panels: [
        {
          type: "table",
          title: "Recent activity",
          columns: ["When", "What"],
          rows: [{ When: "2026-04-15", What: "email opened" }],
        },
      ],
    });
    expect(result.success).toBe(true);
    if (result.success) expect(result.manifest.panels).toHaveLength(1);
  });

  it("accepts a manifest with multiple panel types", () => {
    const result = validateManifest({
      panels: [
        { type: "profile", objectType: "organization", objectId: "x", fields: { Name: "Acme" } },
        { type: "kpi_rail", metrics: [{ label: "ARR", value: "$120k", trend: "up" }] },
        {
          type: "evidence",
          items: [
            {
              chunk_id: "c1",
              source_ref: "summary v1 / Acme profile",
              occurred_at: null,
              freshness_hours: 12,
              confidence_score: 0.91,
            },
          ],
        },
      ],
    });
    expect(result.success).toBe(true);
  });

  it("returns a fallback (never throws) on a malformed manifest", () => {
    const result = validateManifest({ panels: [{ type: "iframe", src: "evil" }] });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.fallback.panels[0]?.type).toBe("table");
    }
  });

  it("rejects evidence items with confidence outside [0,1]", () => {
    const result = validateManifest({
      panels: [
        {
          type: "evidence",
          items: [
            {
              chunk_id: "c1",
              source_ref: "x",
              occurred_at: null,
              freshness_hours: 1,
              confidence_score: 1.5,
            },
          ],
        },
      ],
    });
    expect(result.success).toBe(false);
  });

  it("rejects an empty kpi_rail (must have at least one metric)", () => {
    const result = validateManifest({ panels: [{ type: "kpi_rail", metrics: [] }] });
    expect(result.success).toBe(false);
  });

  it("accepts a filterable_table with filter + sort config", () => {
    const result = validateManifest({
      panels: [
        {
          type: "filterable_table",
          title: "Open rice deals",
          columns: ["Deal ref", "Buyer", "Destination", "EBITDA", "Status"],
          rows: [
            {
              "Deal ref": "VTC-2026-001",
              Buyer: "Acme Rice",
              Destination: "Port-au-Prince",
              EBITDA: "$45,000",
              Status: "negotiating",
            },
          ],
          filterableColumns: ["Buyer", "Destination", "Status"],
          sortableColumns: ["EBITDA"],
          defaultSort: { column: "EBITDA", direction: "desc" },
          tone: { Status: { negotiating: "warn", settled: "good", failed: "bad" } },
        },
      ],
    });
    expect(result.success).toBe(true);
    if (result.success) {
      const p = result.manifest.panels[0];
      expect(p?.type).toBe("filterable_table");
    }
  });

  it("defaults filterable_table filter/sort arrays to [] when omitted", () => {
    const result = validateManifest({
      panels: [
        {
          type: "filterable_table",
          title: "x",
          columns: ["A"],
          rows: [{ A: "1" }],
        },
      ],
    });
    expect(result.success).toBe(true);
    if (result.success) {
      const p = result.manifest.panels[0];
      if (p?.type === "filterable_table") {
        expect(p.filterableColumns).toEqual([]);
        expect(p.sortableColumns).toEqual([]);
      } else {
        throw new Error("expected filterable_table");
      }
    }
  });

  it("accepts an approval_flow panel with tiered steps", () => {
    const result = validateManifest({
      panels: [
        {
          type: "approval_flow",
          title: "Deal VTC-2026-008 — approval timeline",
          contextRef: "VTC-2026-008",
          steps: [
            {
              tier: "T1",
              label: "Lead qualification",
              status: "auto_approved",
              actionType: "lead.qualify",
              occurredAt: "2026-04-20T15:04:00Z",
            },
            {
              tier: "T2",
              label: "Buyer reply (email.send)",
              status: "approved",
              approvalId: "01HAPPROVAL0000000000000001",
              actionType: "email.send",
              occurredAt: "2026-04-20T15:07:00Z",
              reviewer: "colekut4",
            },
            {
              tier: "T2",
              label: "Create buy-side deal",
              status: "pending",
              approvalId: "01HAPPROVAL0000000000000002",
              actionType: "crm.create_deal",
              blockers: ["OFAC screening not cleared"],
            },
            {
              tier: "T3",
              label: "Counterparty risk review",
              status: "not_started",
            },
          ],
        },
      ],
    });
    expect(result.success).toBe(true);
    if (result.success) {
      const p = result.manifest.panels[0];
      if (p?.type === "approval_flow") {
        expect(p.steps).toHaveLength(4);
      } else {
        throw new Error("expected approval_flow");
      }
    }
  });

  it("rejects approval_flow with an unknown tier", () => {
    const result = validateManifest({
      panels: [
        {
          type: "approval_flow",
          title: "x",
          steps: [{ tier: "T4", label: "bad", status: "pending" }],
        },
      ],
    });
    expect(result.success).toBe(false);
  });

  it("rejects approval_flow with an unknown status", () => {
    const result = validateManifest({
      panels: [
        {
          type: "approval_flow",
          title: "x",
          steps: [{ tier: "T2", label: "y", status: "stalled" }],
        },
      ],
    });
    expect(result.success).toBe(false);
  });

  it("accepts a risk_heatmap with mixed tiers and OFAC statuses", () => {
    const result = validateManifest({
      panels: [
        {
          type: "risk_heatmap",
          title: "Caribbean buyer exposure",
          rows: [
            {
              organizationId: "01HORG_A",
              organizationName: "Port-au-Prince Trading",
              tier: "tier_2",
              ofacStatus: "cleared",
              dealCount: 3,
              totalExposureUsd: 1_250_000,
              lastPaymentDaysAgo: 14,
            },
            {
              organizationId: "01HORG_B",
              organizationName: "Santo Domingo Fuels",
              tier: "watch",
              ofacStatus: "in_progress",
              dealCount: 1,
              totalExposureUsd: 450_000,
            },
            {
              organizationId: "01HORG_C",
              organizationName: "Kingston Commodities",
              tier: "declined",
              ofacStatus: "rejected",
              dealCount: 0,
              totalExposureUsd: 0,
            },
          ],
        },
      ],
    });
    expect(result.success).toBe(true);
    if (result.success) {
      const p = result.manifest.panels[0];
      if (p?.type === "risk_heatmap") expect(p.rows).toHaveLength(3);
      else throw new Error("expected risk_heatmap");
    }
  });

  it("rejects risk_heatmap with unknown tier", () => {
    const result = validateManifest({
      panels: [
        {
          type: "risk_heatmap",
          title: "x",
          rows: [
            {
              organizationId: "x",
              organizationName: "X",
              tier: "tier_4",
              ofacStatus: "cleared",
              dealCount: 0,
              totalExposureUsd: 0,
            },
          ],
        },
      ],
    });
    expect(result.success).toBe(false);
  });

  it("rejects risk_heatmap with negative exposure", () => {
    const result = validateManifest({
      panels: [
        {
          type: "risk_heatmap",
          title: "x",
          rows: [
            {
              organizationId: "x",
              organizationName: "X",
              tier: "tier_1",
              ofacStatus: "cleared",
              dealCount: 0,
              totalExposureUsd: -5,
            },
          ],
        },
      ],
    });
    expect(result.success).toBe(false);
  });

  it("rejects approval_flow with zero steps", () => {
    const result = validateManifest({
      panels: [{ type: "approval_flow", title: "x", steps: [] }],
    });
    expect(result.success).toBe(false);
  });

  it("rejects filterable_table with invalid defaultSort direction", () => {
    const result = validateManifest({
      panels: [
        {
          type: "filterable_table",
          title: "x",
          columns: ["A"],
          rows: [],
          defaultSort: { column: "A", direction: "bogus" },
        },
      ],
    });
    expect(result.success).toBe(false);
  });

  it("rejects a campaign panel claiming open_confidence: strong", () => {
    const result = validateManifest({
      panels: [
        {
          type: "campaign",
          campaignId: "c1",
          sent: 100,
          delivered: 95,
          clicked: 5,
          opened: 30,
          bounced: 5,
          click_rate: 0.05,
          open_rate: 0.3,
          open_confidence: "strong",
        },
      ],
    });
    expect(result.success).toBe(false);
  });
});

describe("manifestFallback", () => {
  it("packages text into a single-row table panel", () => {
    const fallback = manifestFallback("hello world");
    expect(fallback.panels).toHaveLength(1);
    const [panel] = fallback.panels;
    if (panel?.type === "table") {
      expect(panel.rows[0]?.["text"]).toBe("hello world");
    } else {
      throw new Error("expected table panel");
    }
  });
});
