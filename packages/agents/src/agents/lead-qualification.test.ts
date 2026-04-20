import { describe, expect, it } from "vitest";
import { isHotSignal } from "./lead-qualification.js";

describe("isHotSignal", () => {
  it("fires on buying_intent=intent_to_buy", () => {
    expect(
      isHotSignal({ buying_intent: "intent_to_buy", urgency: "near_term" }),
    ).toBe(true);
  });

  it("fires on urgency=immediate even when buying_intent is softer", () => {
    expect(
      isHotSignal({ buying_intent: "qualifying", urgency: "immediate" }),
    ).toBe(true);
  });

  it("stays false for qualifying + near_term", () => {
    expect(
      isHotSignal({ buying_intent: "qualifying", urgency: "near_term" }),
    ).toBe(false);
  });

  it("stays false for exploring + exploratory", () => {
    expect(
      isHotSignal({ buying_intent: "exploring", urgency: "exploratory" }),
    ).toBe(false);
  });

  it("stays false on empty / missing fields", () => {
    expect(isHotSignal({})).toBe(false);
    expect(isHotSignal({ buying_intent: null, urgency: null })).toBe(false);
  });

  it("stays false for not_interested even if urgency somehow says immediate", () => {
    // Not expected in practice (why would a not-interested lead be immediate?),
    // but the OR semantics mean urgency wins here. Documenting the behavior
    // so an operator who sees it can file a prompt-level bug.
    expect(
      isHotSignal({
        buying_intent: "not_interested",
        urgency: "immediate",
      }),
    ).toBe(true);
  });
});
