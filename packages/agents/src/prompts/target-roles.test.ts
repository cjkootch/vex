import { describe, expect, it } from "vitest";
import { renderTargetRolesPreamble } from "./target-roles.js";

describe("renderTargetRolesPreamble", () => {
  it("returns empty string for null / undefined / empty", () => {
    expect(renderTargetRolesPreamble(null)).toBe("");
    expect(renderTargetRolesPreamble(undefined)).toBe("");
    expect(renderTargetRolesPreamble({})).toBe("");
  });

  it("returns empty string when every category has an empty list", () => {
    expect(renderTargetRolesPreamble({ fuel: [], food: [] })).toBe("");
  });

  it("renders categories with their ordered title list", () => {
    const out = renderTargetRolesPreamble({
      fuel: [
        "Fuel Procurement Manager",
        "Trading Desk Lead",
        "Spot Operations",
      ],
      food: ["Procurement Director", "Sourcing Manager"],
    });
    expect(out).toContain("Target roles by category");
    expect(out).toContain("- **fuel**:");
    expect(out).toContain(
      "Fuel Procurement Manager, Trading Desk Lead, Spot Operations",
    );
    expect(out).toContain("- **food**:");
    expect(out).toContain("Procurement Director, Sourcing Manager");
  });

  it("includes the clarifier-vs-direct guidance for the chat agent", () => {
    const out = renderTargetRolesPreamble({
      fuel: ["Fuel Procurement Manager"],
    });
    expect(out).toContain("clarifier options");
    expect(out).toContain("research_contact");
    expect(out).toContain("candidate titles");
  });

  it("skips empty-list categories within a partly-populated registry", () => {
    const out = renderTargetRolesPreamble({
      fuel: ["Fuel Procurement Manager"],
      food: [],
    });
    expect(out).toContain("- **fuel**:");
    expect(out).not.toContain("- **food**:");
  });
});
