import { describe, expect, it } from "vitest";
import { formatFromHeader } from "./resend.js";

describe("formatFromHeader", () => {
  const VERIFIED = "vector@vexhq.ai";

  it("returns the bare verified address when no display name", () => {
    expect(formatFromHeader(VERIFIED)).toBe(VERIFIED);
    expect(formatFromHeader(VERIFIED, "")).toBe(VERIFIED);
    expect(formatFromHeader(VERIFIED, "   ")).toBe(VERIFIED);
  });

  it("wraps a display name as RFC-5322 quoted-string", () => {
    expect(formatFromHeader(VERIFIED, "Cole Kutschinski")).toBe(
      `"Cole Kutschinski" <vector@vexhq.ai>`,
    );
  });

  it("trims surrounding whitespace from the display name", () => {
    expect(formatFromHeader(VERIFIED, "  Cole  ")).toBe(
      `"Cole" <vector@vexhq.ai>`,
    );
  });

  it("escapes embedded double-quotes in the display name", () => {
    expect(formatFromHeader(VERIFIED, 'He said "hi"')).toBe(
      `"He said \\"hi\\"" <vector@vexhq.ai>`,
    );
  });

  it("passes a pre-formatted name<addr> string through verbatim", () => {
    const preformatted = `"Cole" <vector@vexhq.ai>`;
    expect(formatFromHeader(VERIFIED, preformatted)).toBe(preformatted);
  });
});
