import { describe, expect, it } from "vitest";
import { renderStrategyPreamble } from "./strategy.js";

describe("renderStrategyPreamble", () => {
  it("returns an empty string for null / undefined / empty strategy", () => {
    expect(renderStrategyPreamble(null)).toBe("");
    expect(renderStrategyPreamble(undefined)).toBe("");
    expect(renderStrategyPreamble({})).toBe("");
  });

  it("returns an empty string when every slot is blank or empty", () => {
    expect(
      renderStrategyPreamble({
        mission: "",
        target_markets: [],
        icp_buyers: "",
        no_go_zones: [],
        growth_priorities: [],
      }),
    ).toBe("");
  });

  it("renders mission only when no other slots are filled", () => {
    const out = renderStrategyPreamble({ mission: "Do the thing" });
    expect(out).toContain("## Company context");
    expect(out).toContain("Mission: Do the thing");
    expect(out).not.toContain("ICP");
  });

  it("joins target_markets with oxford-comma and a period", () => {
    const out = renderStrategyPreamble({
      target_markets: ["Caribbean", "Central America", "US Gulf"],
    });
    expect(out).toContain(
      "Target markets: Caribbean, Central America, and US Gulf.",
    );
  });

  it("handles single-item and two-item array joins", () => {
    expect(
      renderStrategyPreamble({ target_markets: ["Caribbean"] }),
    ).toContain("Target markets: Caribbean.");
    expect(
      renderStrategyPreamble({
        target_markets: ["Caribbean", "US Gulf"],
      }),
    ).toContain("Target markets: Caribbean and US Gulf.");
  });

  it("prefixes no_go_zones with a do-not-touch instruction", () => {
    const out = renderStrategyPreamble({
      no_go_zones: ["Cuba", "OFAC entities"],
    });
    expect(out).toContain(
      "No-go zones (never propose actions that touch these): Cuba and OFAC entities.",
    );
  });

  it("prefixes growth_priorities with a bias-toward instruction", () => {
    const out = renderStrategyPreamble({
      growth_priorities: ["Land 3 rice buyers"],
    });
    expect(out).toContain(
      "Growth priorities this quarter (bias proposals toward these): Land 3 rice buyers.",
    );
  });

  it("skips slots that are only whitespace", () => {
    const out = renderStrategyPreamble({
      mission: "   ",
      icp_buyers: "",
      brand_voice: "Direct",
    });
    expect(out).toContain("Brand voice: Direct");
    expect(out).not.toContain("Mission:");
    expect(out).not.toContain("ICP buyers:");
  });

  it("ends with a --- separator so the main prompt doesn't blur into the preamble", () => {
    const out = renderStrategyPreamble({ mission: "Do the thing" });
    expect(out.trimEnd().endsWith("---")).toBe(true);
  });
});
