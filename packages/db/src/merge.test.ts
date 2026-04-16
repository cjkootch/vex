import { describe, expect, it } from "vitest";
import { resolveFieldValue, type FieldConfidenceEntry } from "./merge.js";

const priority = ["internal", "apollo", "ga4", "resend"] as const;
const at = "2026-05-01T00:00:00.000Z";

const entry = (overrides: Partial<FieldConfidenceEntry>): FieldConfidenceEntry => ({
  value: "x",
  source: "apollo",
  confidence: 0.5,
  updated_at: at,
  ...overrides,
});

describe("resolveFieldValue", () => {
  it("prefers a higher-priority source over a lower-priority one", () => {
    const existing = entry({ source: "apollo", confidence: 0.7 });
    const incoming = entry({ source: "internal", confidence: 0.5, value: "new" });
    expect(resolveFieldValue(existing, incoming, priority)).toBe(incoming);
  });

  it("keeps the existing when incoming has lower priority and similar confidence", () => {
    const existing = entry({ source: "apollo", confidence: 0.7 });
    const incoming = entry({ source: "ga4", confidence: 0.72, value: "new" });
    expect(resolveFieldValue(existing, incoming, priority)).toBe(existing);
  });

  it("tie-breaks same-priority sources by confidence", () => {
    const existing = entry({ source: "apollo", confidence: 0.5 });
    const incoming = entry({ source: "apollo", confidence: 0.7, value: "new" });
    expect(resolveFieldValue(existing, incoming, priority)).toBe(incoming);
  });

  it("overrides regardless of priority when confidence gap exceeds 0.2", () => {
    const existing = entry({ source: "internal", confidence: 0.3 });
    const incoming = entry({ source: "resend", confidence: 0.6, value: "new" });
    expect(resolveFieldValue(existing, incoming, priority)).toBe(incoming);
  });

  it("does NOT override on a confidence gap of exactly 0.2", () => {
    const existing = entry({ source: "internal", confidence: 0.5 });
    const incoming = entry({ source: "resend", confidence: 0.7, value: "new" });
    expect(resolveFieldValue(existing, incoming, priority)).toBe(existing);
  });

  it("treats unknown sources as lowest priority", () => {
    const existing = entry({ source: "apollo", confidence: 0.5 });
    const incoming = entry({ source: "some_random_scraper", confidence: 0.5 });
    expect(resolveFieldValue(existing, incoming, priority)).toBe(existing);
  });

  it("accepts incoming when both sources are unknown but incoming confidence is higher", () => {
    const existing = entry({ source: "scraper_a", confidence: 0.3 });
    const incoming = entry({ source: "scraper_b", confidence: 0.4 });
    expect(resolveFieldValue(existing, incoming, priority)).toBe(incoming);
  });
});
