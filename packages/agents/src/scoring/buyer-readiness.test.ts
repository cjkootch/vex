import { describe, expect, it } from "vitest";
import {
  scoreBuyerReadiness,
  type BuyerReadinessSignals,
} from "./buyer-readiness.js";

function baseSignals(overrides: Partial<BuyerReadinessSignals> = {}): BuyerReadinessSignals {
  return {
    counterpartyTier: "medium",
    counterpartyComposite: 50,
    touchpointCount30d: 0,
    daysSinceLastInbound: null,
    openFollowUpCount: 0,
    activeDealCount: 0,
    priceFavorability: null,
    ...overrides,
  };
}

describe("scoreBuyerReadiness", () => {
  it("flags prohibited counterparties as blocked regardless of other signals", () => {
    const result = scoreBuyerReadiness(
      baseSignals({
        counterpartyTier: "prohibited",
        touchpointCount30d: 20,
        daysSinceLastInbound: 1,
        openFollowUpCount: 3,
        activeDealCount: 3,
        priceFavorability: 1,
      }),
    );
    expect(result.blocked).toBe(true);
    expect(result.blockReason).toBe("counterparty_prohibited");
    expect(result.score).toBe(0);
    expect(result.band).toBe("cold");
  });

  it("returns a cold band for a buyer with no engagement signals", () => {
    const result = scoreBuyerReadiness(baseSignals());
    expect(result.blocked).toBe(false);
    expect(result.band).toBe("cold");
    expect(result.score).toBeLessThan(25);
  });

  it("places a strongly-engaged low-risk buyer in the hot band", () => {
    const result = scoreBuyerReadiness(
      baseSignals({
        counterpartyTier: "low",
        counterpartyComposite: 15,
        touchpointCount30d: 20,
        daysSinceLastInbound: 1,
        openFollowUpCount: 2,
        activeDealCount: 1,
        priceFavorability: 0.8,
      }),
    );
    expect(result.band).toBe("hot");
    expect(result.score).toBeGreaterThanOrEqual(75);
  });

  it("contributions are deterministic and include every dimension", () => {
    const signals = baseSignals({
      counterpartyTier: "medium",
      touchpointCount30d: 5,
      daysSinceLastInbound: 10,
      openFollowUpCount: 1,
      activeDealCount: 0,
      priceFavorability: 0,
    });
    const first = scoreBuyerReadiness(signals);
    const second = scoreBuyerReadiness(signals);
    expect(second.score).toBe(first.score);
    const dims = first.contributions.map((c) => c.dimension);
    expect(dims).toEqual([
      "counterparty_tier",
      "touchpoints_30d",
      "recency",
      "momentum",
      "price_favorability",
    ]);
  });

  it("clamps abnormal price favorability into [-1, +1]", () => {
    const above = scoreBuyerReadiness(baseSignals({ priceFavorability: 5 }));
    const below = scoreBuyerReadiness(baseSignals({ priceFavorability: -5 }));
    const max = scoreBuyerReadiness(baseSignals({ priceFavorability: 1 }));
    const min = scoreBuyerReadiness(baseSignals({ priceFavorability: -1 }));
    expect(above.score).toBe(max.score);
    expect(below.score).toBe(min.score);
  });

  it("composite risk nudges the score within a tier", () => {
    const cleanLowRisk = scoreBuyerReadiness(
      baseSignals({ counterpartyTier: "low", counterpartyComposite: 10 }),
    );
    const dirtyLowRisk = scoreBuyerReadiness(
      baseSignals({ counterpartyTier: "low", counterpartyComposite: 45 }),
    );
    expect(cleanLowRisk.score).toBeGreaterThan(dirtyLowRisk.score);
  });
});
