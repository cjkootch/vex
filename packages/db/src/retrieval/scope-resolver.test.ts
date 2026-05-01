import { describe, expect, it } from "vitest";
import { extractCandidateTokens } from "./scope-resolver.js";

/**
 * Token-extraction tests. The scope-resolver feeds these tokens into
 * a case-insensitive `ILIKE '%token%'` against contacts.full_name +
 * organizations.legal_name, so the only contract that matters here is:
 * "if the operator typed a name in any case, return it as a token."
 */
describe("extractCandidateTokens", () => {
  it("extracts lowercase first names (the original bug)", () => {
    const tokens = extractCandidateTokens("send cole a test text");
    // "cole" must be present — the chat scope-resolver missed contacts
    // whose name appeared lowercase before the case-insensitive fix.
    expect(tokens).toContain("cole");
  });

  it("extracts lowercase first + last name pairs", () => {
    const tokens = extractCandidateTokens(
      "draft a quick email to amber hamby about Q3",
    );
    // The two-word match clause should pick up the full name as a unit.
    expect(tokens.some((t) => t.toLowerCase().includes("amber hamby"))).toBe(
      true,
    );
  });

  it("still extracts capitalized names + multi-word capitalized pairs", () => {
    const tokens = extractCandidateTokens(
      'Show me Acme Trading and "Vector Trade Capital"',
    );
    // Quoted phrase preserved verbatim.
    expect(tokens).toContain("Vector Trade Capital");
    // Capitalized two-word pair preserved.
    expect(tokens.some((t) => t.includes("Acme Trading"))).toBe(true);
  });

  it("strips action verbs + channel words so they don't pollute ILIKE matches", () => {
    const tokens = extractCandidateTokens(
      "send cole a test sms and whatsapp message",
    );
    expect(tokens).not.toContain("send");
    expect(tokens).not.toContain("sms");
    expect(tokens).not.toContain("whatsapp");
    expect(tokens).not.toContain("message");
    expect(tokens).not.toContain("test");
    // The actual entity stays.
    expect(tokens).toContain("cole");
  });

  it("strips question / connective fillers in either case", () => {
    const tokens = extractCandidateTokens(
      "Where is the Acme deal and how is it going",
    );
    expect(tokens).not.toContain("Where");
    expect(tokens).not.toContain("the");
    expect(tokens).not.toContain("how");
    expect(tokens.some((t) => t.includes("Acme"))).toBe(true);
  });

  it("preserves single-quoted contact names with hyphens / apostrophes", () => {
    const tokens = extractCandidateTokens('look up "O\'Brien" on procur');
    expect(tokens).toContain("O'Brien");
  });

  it("returns an empty list for queries with no entity-shaped tokens", () => {
    expect(extractCandidateTokens("hi")).toEqual([]);
    expect(extractCandidateTokens("")).toEqual([]);
  });
});
