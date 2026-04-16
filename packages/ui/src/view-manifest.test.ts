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
