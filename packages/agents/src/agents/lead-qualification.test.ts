import { describe, expect, it } from "vitest";
import {
  buildDealProposal,
  buildSupplierRfqProposals,
  extractDraftReply,
  isHotSignal,
  mapQualificationProduct,
  parseVolume,
  renderSupplierRfqBody,
} from "./lead-qualification.js";
import type { AgentContext } from "./types.js";

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

describe("renderSupplierRfqBody", () => {
  it("builds a subject + body with all the fields present", () => {
    const out = renderSupplierRfqBody({
      product: "rice",
      volume: "500 MT",
      destination: "Port-au-Prince",
      timeline: "Q3 2026",
      dealRef: "VTC-2026-LABC123",
    });
    expect(out.subject).toContain("500 MT");
    expect(out.subject).toContain("rice");
    expect(out.subject).toContain("Port-au-Prince");
    expect(out.subject).toContain("Q3 2026");
    expect(out.body).toContain("500 MT of rice");
    expect(out.body).toContain("into Port-au-Prince");
    expect(out.body).toContain("on Q3 2026");
    expect(out.body).toContain("CIF, LC60D");
    expect(out.body).toContain("VTC-2026-LABC123");
  });

  it("gracefully omits destination / timeline / ref when not supplied", () => {
    const out = renderSupplierRfqBody({ product: "ulsd", volume: "2,000 USG" });
    expect(out.subject).toBe("RFQ — 2,000 USG ulsd");
    expect(out.body).not.toContain("into ");
    expect(out.body).not.toContain(" on ");
    expect(out.body).toContain("Thanks,");
  });

  it("truncates unreasonably-long subjects", () => {
    const out = renderSupplierRfqBody({
      product: "rice-long-product-name-that-goes-on-and-on",
      volume: "500 MT",
      destination: "A-very-long-destination-name-that-exceeds-reasonable-bounds",
      timeline: "a-long-timeline-string-because-llms-be-llms",
    });
    expect(out.subject.length).toBeLessThanOrEqual(140);
  });
});

describe("buildSupplierRfqProposals", () => {
  const tx = {} as never;
  const buyerOrgId = "01HORG_BUYER";
  const leadId = "01HLEAD_A";
  const parsed: Record<string, unknown> = {
    destination: "Port-au-Prince",
    timeline: "Q3 2026",
  };
  const dealPayload: Record<string, unknown> = {
    product: "rice",
    volumeUsg: 500,
    volumeUnit: "mt",
    dealRef: "VTC-2026-LABC123",
  };

  function makeCtx(overrides: {
    listForProduct?: (product: string) => Promise<unknown[]>;
    findById?: (orgId: string) => Promise<unknown>;
    findByOrgId?: (orgId: string) => Promise<unknown[]>;
  }): AgentContext {
    // Real repo signatures are (tx, key, ...); tests don't care about
    // tx, so we swallow it and forward the semantic key.
    return {
      tx,
      orgProducts: {
        listForProduct: async (_tx: unknown, product: string) =>
          overrides.listForProduct
            ? overrides.listForProduct(product)
            : [],
      },
      organizations: {
        findById: async (_tx: unknown, orgId: string) =>
          overrides.findById ? overrides.findById(orgId) : null,
      },
      contacts: {
        findByOrgId: async (_tx: unknown, orgId: string) =>
          overrides.findByOrgId ? overrides.findByOrgId(orgId) : [],
      },
    } as unknown as AgentContext;
  }

  it("emits one email.send per qualified supplier up to maxDrafts", async () => {
    const orgRows = [
      { orgId: "01HORG_S1" },
      { orgId: "01HORG_S2" },
      { orgId: "01HORG_S3" },
      { orgId: "01HORG_S4" },
    ];
    const orgs = new Map([
      ["01HORG_S1", { id: "01HORG_S1", legalName: "Supplier 1", kind: "supplier" }],
      ["01HORG_S2", { id: "01HORG_S2", legalName: "Supplier 2", kind: "supplier" }],
      ["01HORG_S3", { id: "01HORG_S3", legalName: "Supplier 3", kind: "supplier" }],
      ["01HORG_S4", { id: "01HORG_S4", legalName: "Supplier 4", kind: "supplier" }],
    ]);
    const contacts = new Map([
      ["01HORG_S1", [{ id: "c1", emails: ["s1@example.com"] }]],
      ["01HORG_S2", [{ id: "c2", emails: ["s2@example.com"] }]],
      ["01HORG_S3", [{ id: "c3", emails: ["s3@example.com"] }]],
      ["01HORG_S4", [{ id: "c4", emails: ["s4@example.com"] }]],
    ]);
    const ctx = makeCtx({
      listForProduct: async () => orgRows,
      findById: async (orgId) => orgs.get(orgId) ?? null,
      findByOrgId: async (orgId) => contacts.get(orgId) ?? [],
    });
    const out = await buildSupplierRfqProposals({
      ctx,
      parsed,
      dealPayload,
      buyerOrgId,
      leadId,
      maxDrafts: 3,
    });
    expect(out).toHaveLength(3);
    expect(out[0]!.kind).toBe("email.send");
    expect(out[0]!.tier).toBe("T2");
    const payload = out[0]!.payload as Record<string, unknown>;
    expect(payload["auto_drafted_from"]).toBe("lead_qualification.supplier_rfq");
    expect(payload["supplier_org_id"]).toBe("01HORG_S1");
    expect(payload["lead_id"]).toBe(leadId);
    expect(payload["to"]).toEqual(["s1@example.com"]);
  });

  it("skips the buyer's own org", async () => {
    const ctx = makeCtx({
      listForProduct: async () => [{ orgId: buyerOrgId }, { orgId: "01HORG_S1" }],
      findById: async (id) => ({
        id,
        legalName: "Supplier",
        kind: "supplier",
      }),
      findByOrgId: async () => [{ id: "c1", emails: ["x@example.com"] }],
    });
    const out = await buildSupplierRfqProposals({
      ctx,
      parsed,
      dealPayload,
      buyerOrgId,
      leadId,
      maxDrafts: 3,
    });
    expect(out).toHaveLength(1);
    expect((out[0]!.payload as Record<string, unknown>)["supplier_org_id"]).toBe("01HORG_S1");
  });

  it("skips orgs whose kind isn't supplier / broker", async () => {
    const ctx = makeCtx({
      listForProduct: async () => [
        { orgId: "01HORG_B" },
        { orgId: "01HORG_SUP" },
      ],
      findById: async (id) => ({
        id,
        legalName: id,
        kind: id === "01HORG_B" ? "buyer" : "supplier",
      }),
      findByOrgId: async () => [{ id: "c1", emails: ["x@example.com"] }],
    });
    const out = await buildSupplierRfqProposals({
      ctx,
      parsed,
      dealPayload,
      buyerOrgId,
      leadId,
      maxDrafts: 3,
    });
    expect(out).toHaveLength(1);
    expect((out[0]!.payload as Record<string, unknown>)["supplier_org_id"]).toBe("01HORG_SUP");
  });

  it("skips suppliers with no emailable contact", async () => {
    const ctx = makeCtx({
      listForProduct: async () => [{ orgId: "01HORG_S1" }, { orgId: "01HORG_S2" }],
      findById: async (id) => ({ id, legalName: id, kind: "supplier" }),
      findByOrgId: async (orgId) =>
        orgId === "01HORG_S1"
          ? [{ id: "c1", emails: [] }] // no emails
          : [{ id: "c2", emails: ["ok@example.com"] }],
    });
    const out = await buildSupplierRfqProposals({
      ctx,
      parsed,
      dealPayload,
      buyerOrgId,
      leadId,
      maxDrafts: 3,
    });
    expect(out).toHaveLength(1);
    expect((out[0]!.payload as Record<string, unknown>)["supplier_org_id"]).toBe("01HORG_S2");
  });

  it("returns [] when deal payload is missing product / volume", async () => {
    const ctx = makeCtx({});
    const out = await buildSupplierRfqProposals({
      ctx,
      parsed,
      dealPayload: { dealRef: "X" },
      buyerOrgId,
      leadId,
      maxDrafts: 3,
    });
    expect(out).toEqual([]);
  });

  it("returns [] when no orgs carry the product", async () => {
    const ctx = makeCtx({ listForProduct: async () => [] });
    const out = await buildSupplierRfqProposals({
      ctx,
      parsed,
      dealPayload,
      buyerOrgId,
      leadId,
      maxDrafts: 3,
    });
    expect(out).toEqual([]);
  });

  it("dedupes multiple product rows pointing to the same org", async () => {
    const ctx = makeCtx({
      listForProduct: async () => [
        { orgId: "01HORG_S1" },
        { orgId: "01HORG_S1" }, // duplicate
        { orgId: "01HORG_S2" },
      ],
      findById: async (id) => ({ id, legalName: id, kind: "supplier" }),
      findByOrgId: async () => [{ id: "c", emails: ["x@example.com"] }],
    });
    const out = await buildSupplierRfqProposals({
      ctx,
      parsed,
      dealPayload,
      buyerOrgId,
      leadId,
      maxDrafts: 3,
    });
    expect(out).toHaveLength(2);
    const orgIds = out.map(
      (p) => (p.payload as Record<string, unknown>)["supplier_org_id"],
    );
    expect(orgIds).toEqual(["01HORG_S1", "01HORG_S2"]);
  });
});
