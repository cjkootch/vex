import { describe, expect, it } from "vitest";
import { tokensToUsdMicros, pricing } from "./pricing.js";

describe("tokensToUsdMicros", () => {
  it("converts tokens * $/M to integer micros", () => {
    // 1M tokens at $3/M = $3 = 3_000_000 micros
    expect(tokensToUsdMicros(1_000_000, 3)).toBe(3_000_000);
    // 1K tokens at $3/M = $0.003 = 3_000 micros
    expect(tokensToUsdMicros(1_000, 3)).toBe(3_000);
    // 1 token at $3/M = 3 micros
    expect(tokensToUsdMicros(1, 3)).toBe(3);
  });

  it("has a pricing entry for the pinned reasoning model", () => {
    expect(pricing.anthropic["claude-sonnet-4-20250514"]).toBeDefined();
  });

  it("has a pricing entry for the pinned embedding model", () => {
    expect(pricing.openai["text-embedding-3-small"]).toBeDefined();
  });
});
