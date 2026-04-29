import { describe, expect, it } from "vitest";
import { extractOrgActionsFromPanels } from "./profile-panel-extractor.js";
import type { ManifestPanel } from "@vex/ui";
import type { ProposedAction } from "@vex/integrations";

const ORG_ID = "01KQD7KCSRS26AMHCYRKBF51KM";
const isValidUlid = (s: string): boolean =>
  /^[0-9A-HJKMNP-TV-Z]{26}$/i.test(s);

function profilePanel(fields: Record<string, string>): ManifestPanel {
  return {
    type: "profile",
    objectType: "organization",
    objectId: ORG_ID,
    fields,
  };
}

describe("extractOrgActionsFromPanels", () => {
  it("returns [] when no profile panels", () => {
    const out = extractOrgActionsFromPanels({
      panels: [],
      existingActions: [],
      isValidUlid,
    });
    expect(out).toEqual([]);
  });

  it("skips profile panels for non-organization objectTypes", () => {
    const panels: ManifestPanel[] = [
      {
        type: "profile",
        objectType: "contact",
        objectId: ORG_ID,
        fields: { Industry: "Oil & Gas Refining" },
      },
    ];
    const out = extractOrgActionsFromPanels({
      panels,
      existingActions: [],
      isValidUlid,
    });
    expect(out).toEqual([]);
  });

  it("skips when objectId isn't a valid ULID", () => {
    const panels: ManifestPanel[] = [
      {
        type: "profile",
        objectType: "organization",
        objectId: "not-a-ulid",
        fields: { Industry: "Oil & Gas" },
      },
    ];
    const out = extractOrgActionsFromPanels({
      panels,
      existingActions: [],
      isValidUlid,
    });
    expect(out).toEqual([]);
  });

  it("extracts org.update_fields with industry/country/domain", () => {
    const out = extractOrgActionsFromPanels({
      panels: [
        profilePanel({
          Industry: "Oil & Gas Refining",
          Country: "Algeria",
          Domain: "https://www.cnpc.com.cn/algeria",
        }),
      ],
      existingActions: [],
      isValidUlid,
    });
    const update = out.find((a) => a.kind === "org.update_fields");
    expect(update).toBeDefined();
    expect(update?.payload).toMatchObject({
      orgId: ORG_ID,
      patch: {
        industry: "Oil & Gas Refining",
        country: "DZ",
        domain: "cnpc.com.cn",
      },
    });
  });

  it("ISO-2 country codes pass through unchanged", () => {
    const out = extractOrgActionsFromPanels({
      panels: [profilePanel({ Country: "ch" })],
      existingActions: [],
      isValidUlid,
    });
    const update = out.find((a) => a.kind === "org.update_fields");
    expect((update?.payload as { patch: { country: string } }).patch.country).toBe("CH");
  });

  it("unknown country leaves country off the patch", () => {
    const out = extractOrgActionsFromPanels({
      panels: [profilePanel({ Country: "Atlantis" })],
      existingActions: [],
      isValidUlid,
    });
    const update = out.find((a) => a.kind === "org.update_fields");
    expect(update).toBeUndefined();
  });

  it("extracts org.set_kind from Role field with mixed casing", () => {
    const out = extractOrgActionsFromPanels({
      panels: [profilePanel({ Role: "Supplier" })],
      existingActions: [],
      isValidUlid,
    });
    expect(out).toContainEqual(
      expect.objectContaining({
        kind: "org.set_kind",
        payload: { orgId: ORG_ID, orgKind: "supplier" },
      }),
    );
  });

  it("recognises buyer_broker hyphenated role", () => {
    const out = extractOrgActionsFromPanels({
      panels: [profilePanel({ Role: "Buyer Broker" })],
      existingActions: [],
      isValidUlid,
    });
    expect(out).toContainEqual(
      expect.objectContaining({
        kind: "org.set_kind",
        payload: { orgId: ORG_ID, orgKind: "buyer_broker" },
      }),
    );
  });

  it("emits org.tag refinery from Facility Type field", () => {
    const out = extractOrgActionsFromPanels({
      panels: [profilePanel({ "Facility Type": "Refinery" })],
      existingActions: [],
      isValidUlid,
    });
    expect(out).toContainEqual(
      expect.objectContaining({
        kind: "org.tag",
        payload: { orgId: ORG_ID, tag: "refinery" },
      }),
    );
  });

  it("emits multiple facility tags when the value combines them", () => {
    const out = extractOrgActionsFromPanels({
      panels: [profilePanel({ Type: "Refinery and Terminal" })],
      existingActions: [],
      isValidUlid,
    });
    const tags = out
      .filter((a) => a.kind === "org.tag")
      .map((a) => (a.payload as { tag: string }).tag);
    expect(tags).toContain("refinery");
    expect(tags).toContain("terminal");
  });

  it("emits ownership tags for state-owned + joint-venture", () => {
    const out = extractOrgActionsFromPanels({
      panels: [
        profilePanel({ Ownership: "State-owned joint venture (CNPC 70% / Sonatrach 30%)" }),
      ],
      existingActions: [],
      isValidUlid,
    });
    const tags = out
      .filter((a) => a.kind === "org.tag")
      .map((a) => (a.payload as { tag: string }).tag);
    expect(tags).toContain("state-owned");
    expect(tags).toContain("joint-venture");
  });

  it("expands Products field into per-product org.add_product", () => {
    const out = extractOrgActionsFromPanels({
      panels: [
        profilePanel({ Products: "Gasoline, Diesel, Jet Fuel, LPG" }),
      ],
      existingActions: [],
      isValidUlid,
    });
    const products = out
      .filter((a) => a.kind === "org.add_product")
      .map((a) => (a.payload as { product: string }).product);
    expect(products.sort()).toEqual(["gasoline_87", "jet_a1", "lpg", "ulsd"]);
  });

  it("skips unrecognised products without crashing", () => {
    const out = extractOrgActionsFromPanels({
      panels: [profilePanel({ Products: "Gasoline, Mystery Fuel, LPG" })],
      existingActions: [],
      isValidUlid,
    });
    const products = out
      .filter((a) => a.kind === "org.add_product")
      .map((a) => (a.payload as { product: string }).product);
    expect(products.sort()).toEqual(["gasoline_87", "lpg"]);
  });

  it("end-to-end: CNPC Soralchin example produces full action set", () => {
    const out = extractOrgActionsFromPanels({
      panels: [
        profilePanel({
          "Legal Name": "CNPC Soralchin Adrar Refinery Algeria",
          Industry: "Oil & Gas Refining",
          Country: "Algeria",
          "Facility Type": "Refinery",
          Ownership: "Joint Venture (CNPC 70% / Sonatrach 30%)",
          Capacity: "12,500 bpd",
          Products: "Gasoline, Diesel, Jet Fuel, LPG",
          Role: "Supplier",
        }),
      ],
      existingActions: [],
      isValidUlid,
    });

    const kinds = out.map((a) => a.kind).sort();
    expect(kinds).toEqual([
      "org.add_product",
      "org.add_product",
      "org.add_product",
      "org.add_product",
      "org.set_kind",
      "org.tag",
      "org.tag",
      "org.update_fields",
    ]);

    const tags = out
      .filter((a) => a.kind === "org.tag")
      .map((a) => (a.payload as { tag: string }).tag)
      .sort();
    expect(tags).toEqual(["joint-venture", "refinery"]);
  });

  it("dedupes against existing model-emitted actions", () => {
    const existing: ProposedAction[] = [
      {
        kind: "org.tag",
        tier: "T1",
        payload: { orgId: ORG_ID, tag: "refinery" },
      },
    ];
    const out = extractOrgActionsFromPanels({
      panels: [profilePanel({ "Facility Type": "Refinery" })],
      existingActions: existing,
      isValidUlid,
    });
    const tags = out
      .filter((a) => a.kind === "org.tag")
      .map((a) => (a.payload as { tag: string }).tag);
    expect(tags).not.toContain("refinery"); // already in existingActions
  });
});
