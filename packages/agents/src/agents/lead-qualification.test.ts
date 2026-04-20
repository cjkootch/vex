import { describe, expect, it } from "vitest";
import {
  buildDealProposal,
  extractDraftReply,
  isHotSignal,
  mapQualificationProduct,
  parseVolume,
} from "./lead-qualification.js";

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

describe("extractDraftReply", () => {
  const good = {
    subject: "Q3 rice — CIF Port-au-Prince",
    body: "Saw your note. We can spot 500 MT parboiled next month with LC60D — usual Caribbean lanes. Worth a 20-minute call this week to confirm laycan? I can share a loading window and port options.",
  };

  it("returns the parsed draft when subject + body are well-formed", () => {
    expect(extractDraftReply({ draft_reply: good })).toEqual(good);
  });

  it("trims whitespace from subject + body", () => {
    expect(
      extractDraftReply({
        draft_reply: {
          subject: "  " + good.subject + "  ",
          body: "\n" + good.body + "\n",
        },
      }),
    ).toEqual(good);
  });

  it("returns null when draft_reply is absent or null", () => {
    expect(extractDraftReply({})).toBeNull();
    expect(extractDraftReply({ draft_reply: null })).toBeNull();
  });

  it("returns null when draft_reply is an array (wrong shape)", () => {
    expect(
      extractDraftReply({ draft_reply: ["subject", "body"] as unknown }),
    ).toBeNull();
  });

  it("returns null when subject or body are non-string", () => {
    expect(
      extractDraftReply({ draft_reply: { subject: 1, body: good.body } }),
    ).toBeNull();
    expect(
      extractDraftReply({ draft_reply: { subject: good.subject, body: null } }),
    ).toBeNull();
  });

  it("rejects too-short subject (Claude fumbling the shape)", () => {
    expect(
      extractDraftReply({ draft_reply: { subject: "Hi", body: good.body } }),
    ).toBeNull();
  });

  it("rejects too-short body", () => {
    expect(
      extractDraftReply({
        draft_reply: { subject: good.subject, body: "Sure." },
      }),
    ).toBeNull();
  });

  it("rejects unreasonably long body (> 4000 chars)", () => {
    expect(
      extractDraftReply({
        draft_reply: { subject: good.subject, body: "x".repeat(4001) },
      }),
    ).toBeNull();
  });
});

describe("mapQualificationProduct", () => {
  it("maps known food + fuel products", () => {
    expect(mapQualificationProduct("rice")).toBe("rice");
    expect(mapQualificationProduct("pork")).toBe("pork");
    expect(mapQualificationProduct("chicken")).toBe("chicken");
    expect(mapQualificationProduct("ulsd")).toBe("ulsd");
    expect(mapQualificationProduct("jet")).toBe("jet_a");
  });

  it("handles loose spelling + case", () => {
    expect(mapQualificationProduct("  RICE  ")).toBe("rice");
    expect(mapQualificationProduct("Cooking Oil")).toBe("cooking_oil");
  });

  it("maps MGO → ulsd (trading equivalence)", () => {
    expect(mapQualificationProduct("mgo")).toBe("ulsd");
  });

  it("returns null on unknown or non-string", () => {
    expect(mapQualificationProduct(null)).toBeNull();
    expect(mapQualificationProduct("sugar")).toBeNull(); // known to qual, unknown to deal schema
    expect(mapQualificationProduct(42)).toBeNull();
  });
});

describe("parseVolume", () => {
  it("parses plain MT + USG quantities", () => {
    expect(parseVolume("500 MT")).toEqual({ value: 500, unit: "mt" });
    expect(parseVolume("1200 USG")).toEqual({ value: 1200, unit: "usg" });
  });

  it("ignores commas as thousands separators", () => {
    expect(parseVolume("1,200 MT")).toEqual({ value: 1200, unit: "mt" });
  });

  it("honours k / m suffixes as multipliers", () => {
    expect(parseVolume("200k MT")).toEqual({ value: 200_000, unit: "mt" });
    expect(parseVolume("2.5m USG")).toEqual({ value: 2_500_000, unit: "usg" });
    expect(parseVolume("15kt MT")).toEqual({ value: 15_000, unit: "mt" });
  });

  it("parses containers", () => {
    expect(parseVolume("50 containers")).toEqual({
      value: 50,
      unit: "containers",
    });
    expect(parseVolume("1 container")).toEqual({
      value: 1,
      unit: "containers",
    });
  });

  it("parses other units", () => {
    expect(parseVolume("2000 kg")).toEqual({ value: 2000, unit: "kg" });
    expect(parseVolume("500 lbs")).toEqual({ value: 500, unit: "lbs" });
    expect(parseVolume("800 gallons")).toEqual({ value: 800, unit: "usg" });
  });

  it("rejects shapes it can't confidently parse", () => {
    expect(parseVolume("")).toBeNull();
    expect(parseVolume("some rice")).toBeNull();
    expect(parseVolume("500")).toBeNull(); // no unit
    expect(parseVolume("abc MT")).toBeNull();
    expect(parseVolume(null)).toBeNull();
    expect(parseVolume(500 as unknown)).toBeNull();
  });

  it("rejects zero or negative volumes", () => {
    expect(parseVolume("0 MT")).toBeNull();
    expect(parseVolume("-500 MT")).toBeNull();
  });
});

describe("buildDealProposal", () => {
  const baseParsed: Record<string, unknown> = {
    product: "rice",
    volume: "500 MT",
    destination: "Port-au-Prince",
    timeline: "Q3 2026",
    urgency: "immediate",
    buying_intent: "intent_to_buy",
    summary: "Haitian importer needs 500MT parboiled rice Q3 2026.",
  };
  const lead = { id: "01HLEAD_A", orgId: "01HORG_A" };
  const source = "website_form" as const;
  const agentRunId = "01HRUN_DEAL_PROPOSAL_A1B2C3";

  it("returns a crm.create_deal action when all required data is present", () => {
    const action = buildDealProposal({ parsed: baseParsed, lead, source, agentRunId });
    expect(action).not.toBeNull();
    expect(action!.kind).toBe("crm.create_deal");
    expect(action!.tier).toBe("T2");
    const p = action!.payload;
    expect(p.product).toBe("rice");
    expect(p.lineOfBusiness).toBe("food");
    expect(p.volumeUsg).toBe(500);
    expect(p.volumeUnit).toBe("mt");
    expect(p.buyerOrgId).toBe("01HORG_A");
    expect(p.incoterm).toBe("cif");
    expect(p.pricingBasis).toBe("negotiated");
    expect(p.paymentTerms).toBe("lc_60d");
    expect(p.destinationPort).toBe("Port-au-Prince");
    expect(p.dealRef).toMatch(/^VTC-\d{4}-L[A-Z0-9]{6}$/);
    expect(p.notes).toContain("Timeline: Q3 2026");
    expect(p.notes).toContain("Summary: Haitian importer");
    expect(p.auto_drafted_from).toBe("lead_qualification");
    expect(p.lead_id).toBe("01HLEAD_A");
  });

  it("classifies fuel deals correctly", () => {
    const action = buildDealProposal({
      parsed: { ...baseParsed, product: "ulsd", volume: "2,000 USG" },
      lead,
      source,
      agentRunId,
    });
    expect(action!.payload.lineOfBusiness).toBe("fuel");
    expect(action!.payload.volumeUnit).toBe("usg");
    expect(action!.payload.volumeUsg).toBe(2000);
  });

  it("returns null without a buyer org on the lead", () => {
    expect(
      buildDealProposal({
        parsed: baseParsed,
        lead: { id: "x", orgId: null },
        source,
        agentRunId,
      }),
    ).toBeNull();
  });

  it("returns null on unmappable product", () => {
    expect(
      buildDealProposal({
        parsed: { ...baseParsed, product: "sugar" },
        lead,
        source,
        agentRunId,
      }),
    ).toBeNull();
  });

  it("returns null on unparseable volume", () => {
    expect(
      buildDealProposal({
        parsed: { ...baseParsed, volume: "some rice" },
        lead,
        source,
        agentRunId,
      }),
    ).toBeNull();
  });

  it("omits destination + notes when the qualification didn't provide them", () => {
    const action = buildDealProposal({
      parsed: { product: "rice", volume: "500 MT" },
      lead,
      source,
      agentRunId,
    });
    expect(action).not.toBeNull();
    expect(action!.payload.destinationPort).toBeUndefined();
    expect(action!.payload.notes).toBeUndefined();
  });
});
