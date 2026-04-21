import { describe, expect, it } from "vitest";
import {
  calculateFuelDeal,
  computeFreightCost,
  computeVesselUtilization,
  dealVolumeMt,
  type FuelDealInputs,
  type VesselSpec,
} from "./calculator.js";

const baseInputs: FuelDealInputs = {
  dealRef: "TEST-001",
  product: "ulsd",
  incoterm: "cfr",
  volumeUsg: 3_000_000,
  densityKgL: 0.84,
  volumeTolerancePct: 0,
  sellPricePerUsg: 3.1,
  buyerCurrencyCode: "usd",
  fxRateToUsd: 1,
  productCostPerUsg: 2.05,
  productQualityPremiumPerUsg: 0,
  freightPerUsg: 0.11,
  cargoInsurancePct: 0.002,
  warRiskPremiumPct: 0,
  politicalRiskPremiumPct: 0,
  dischargeHandlingPerUsg: 0.1,
  compliancePerUsg: 0,
  tradeFinancePerUsg: 0,
  intermediaryFeePerUsg: 0,
  vtcVariableOpsPerUsg: 0.02,
  overheadAllocationUsd: 0,
  tradeFinance: { type: "lc_sight" },
  counterpartyRiskScore: 40,
  countryRiskScore: 40,
  thresholds: {
    maxPeakCashExposureUsd: 5_000_000,
    minGrossMarginPct: 0.05,
    minNetMarginPerUsg: 0.03,
    maxCounterpartyRiskScore: 65,
    maxCountryRiskScore: 70,
    maxDemurrageDays: 2,
  },
  monthlyFixedOverheadUsd: 120_000,
};

describe("dealVolumeMt", () => {
  it("converts USG × density × 3.78541 / 1000 to MT", () => {
    // 3M USG × 0.84 kg/L × 3.78541 L/USG / 1000 = 9_539.23 MT
    const mt = dealVolumeMt(3_000_000, 0.84);
    expect(mt).toBeCloseTo(9_539.23, 1);
  });

  it("returns 0 for non-positive inputs", () => {
    expect(dealVolumeMt(0, 0.84)).toBe(0);
    expect(dealVolumeMt(1_000_000, 0)).toBe(0);
  });
});

describe("computeVesselUtilization", () => {
  const vessel: VesselSpec = { class: "mr_tanker", dwtMt: 10_000, maxDraftM: 11 };

  it("returns volumeMt / dwtMt for healthy fills", () => {
    // 3M USG ≈ 9_539 MT on a 10_000 MT hull → ~95.4% utilization
    const u = computeVesselUtilization(
      { volumeUsg: 3_000_000, densityKgL: 0.84 },
      vessel,
    );
    expect(u).toBeCloseTo(0.954, 2);
  });

  it("clamps to 1.05 for slight overload", () => {
    const u = computeVesselUtilization(
      { volumeUsg: 3_500_000, densityKgL: 0.84 }, // ~11_130 MT on 10k DWT
      vessel,
    );
    expect(u).toBe(1.05);
  });

  it("returns null when volumeMt or dwtMt missing", () => {
    expect(
      computeVesselUtilization({ volumeUsg: 0, densityKgL: 0.84 }, vessel),
    ).toBeNull();
    expect(
      computeVesselUtilization(
        { volumeUsg: 3_000_000, densityKgL: 0.84 },
        { class: "mr_tanker", dwtMt: 0, maxDraftM: 11 },
      ),
    ).toBeNull();
  });
});

describe("computeFreightCost", () => {
  it("returns rate × volumeMt and per-USG", () => {
    const c = computeFreightCost(
      { volumeUsg: 3_000_000, densityKgL: 0.84 },
      28.5,
    );
    expect(c).not.toBeNull();
    expect(c!.perMt).toBe(28.5);
    expect(c!.totalUsd).toBeCloseTo(28.5 * 9_539.23, 0);
    expect(c!.perUsg).toBeCloseTo(c!.totalUsd / 3_000_000, 6);
  });

  it("returns null when rate is missing or non-positive", () => {
    expect(
      computeFreightCost({ volumeUsg: 3_000_000, densityKgL: 0.84 }, undefined),
    ).toBeNull();
    expect(
      computeFreightCost({ volumeUsg: 3_000_000, densityKgL: 0.84 }, 0),
    ).toBeNull();
  });
});

describe("calculateFuelDeal — freight integration", () => {
  it("uses freightRateUsdPerMt when set, overriding freightPerUsg", () => {
    const baseline = calculateFuelDeal(baseInputs);
    // With per-MT $28.50 the per-USG works out to ~$0.0907 — different
    // from the baseline $0.11 — so the freight line should change.
    const overridden = calculateFuelDeal({
      ...baseInputs,
      freightRateUsdPerMt: 28.5,
    });
    expect(overridden.perUsg.freight).not.toBeCloseTo(baseline.perUsg.freight, 4);
    expect(overridden.perUsg.freight).toBeCloseTo(
      (28.5 * 9_539.23) / 3_000_000,
      4,
    );
  });

  it("falls back to freightPerUsg when no per-MT rate is set", () => {
    const r = calculateFuelDeal(baseInputs);
    expect(r.perUsg.freight).toBeCloseTo(0.11, 6);
  });

  it("fires freight.rate_missing when vesselSpec but no freight booked", () => {
    const r = calculateFuelDeal({
      ...baseInputs,
      freightPerUsg: 0,
      vesselSpec: { class: "mr_tanker", dwtMt: 48_000, maxDraftM: 12 },
    });
    expect(
      r.warnings.some((w) => w.code === "freight.rate_missing"),
    ).toBe(true);
  });

  it("does not fire freight.rate_missing when a per-MT rate is booked", () => {
    const r = calculateFuelDeal({
      ...baseInputs,
      freightPerUsg: 0,
      freightRateUsdPerMt: 28.5,
      vesselSpec: { class: "mr_tanker", dwtMt: 48_000, maxDraftM: 12 },
    });
    expect(
      r.warnings.find((w) => w.code === "freight.rate_missing"),
    ).toBeUndefined();
  });
});

describe("calculateFuelDeal — freightRateSweep sensitivity", () => {
  it("returns a 2×9 grid centered on the 0% baseline", () => {
    const r = calculateFuelDeal(baseInputs);
    expect(r.sensitivity.freightRateSweep.colLabels).toEqual([
      "-20%",
      "-15%",
      "-10%",
      "-5%",
      "+0%",
      "+5%",
      "+10%",
      "+15%",
      "+20%",
    ]);
    expect(r.sensitivity.freightRateSweep.rowLabels).toEqual([
      "EBITDA $",
      "Peak cash $",
    ]);
    expect(r.sensitivity.freightRateSweep.values).toHaveLength(2);
    expect(r.sensitivity.freightRateSweep.values[0]).toHaveLength(9);
    expect(r.sensitivity.freightRateSweep.highlightCol).toBe(4);
  });

  it("EBITDA is monotonically decreasing as freight rate climbs", () => {
    const r = calculateFuelDeal(baseInputs);
    const ebitdaRow = r.sensitivity.freightRateSweep.values[0]!;
    for (let i = 1; i < ebitdaRow.length; i++) {
      expect(ebitdaRow[i]!).toBeLessThanOrEqual(ebitdaRow[i - 1]!);
    }
  });

  it("returns an empty grid when no freight axis is set", () => {
    const r = calculateFuelDeal({ ...baseInputs, freightPerUsg: 0 });
    expect(r.sensitivity.freightRateSweep.values).toEqual([]);
    expect(r.sensitivity.freightRateSweep.highlightCol).toBe(-1);
  });
});
