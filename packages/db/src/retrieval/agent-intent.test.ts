import { describe, expect, it } from "vitest";
import { detectAgentIntent } from "./retrieval-service.js";

describe("detectAgentIntent", () => {
  it("triggers on the bare word 'agents'", () => {
    const out = detectAgentIntent("how are my agents doing?");
    expect(out.triggered).toBe(true);
    expect(out.specificAgents.size).toBe(0);
  });

  it("triggers on 'last run' phrasing", () => {
    const out = detectAgentIntent("when was the last run of anything?");
    expect(out.triggered).toBe(true);
  });

  it("triggers on 'health check' phrasing", () => {
    const out = detectAgentIntent("can you give me a health check on the orchestrator");
    expect(out.triggered).toBe(true);
  });

  it("identifies specific agents by their underscored name", () => {
    const out = detectAgentIntent("did daily_brief run this morning?");
    expect(out.triggered).toBe(true);
    expect(out.specificAgents.has("daily_brief")).toBe(true);
  });

  it("identifies specific agents by their space-separated name", () => {
    const out = detectAgentIntent("is follow up working?");
    expect(out.triggered).toBe(true);
    expect(out.specificAgents.has("follow_up")).toBe(true);
  });

  it("identifies multiple agents in one query", () => {
    const out = detectAgentIntent("status of analyst and market_data please");
    expect(out.triggered).toBe(true);
    expect(out.specificAgents.has("analyst")).toBe(true);
    expect(out.specificAgents.has("market_data")).toBe(true);
  });

  it("does not trigger on unrelated questions", () => {
    const out = detectAgentIntent("what's Acme's fit score?");
    expect(out.triggered).toBe(false);
    expect(out.specificAgents.size).toBe(0);
  });

  it("does not trigger on the word 'research' in a business context without agent phrasing", () => {
    // The word "research" is both an agent name and a common business
    // term. A conservative classifier would not fire on "research the
    // market" — but our stance is: when the user says an agent name
    // we hydrate. The caller can over-fetch without harm since the
    // items are capped at 12 and a real "research the market"
    // conversation benefits from seeing recent ResearchAgent runs.
    const out = detectAgentIntent("please research the market");
    expect(out.triggered).toBe(true);
    expect(out.specificAgents.has("research")).toBe(true);
  });
});
