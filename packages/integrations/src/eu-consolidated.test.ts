import { describe, expect, it } from "vitest";
import {
  EUConsolidatedAdapter,
  parseEuSanctionsXml,
} from "./eu-consolidated.js";

/**
 * Minimal fixture matching the EU Consolidated XML 1.1 schema. Real
 * exports carry many more attributes per element; we test the fields
 * the parser actually consumes (logicalId, subjectType.code, the
 * primary nameAlias's first/last/whole name, regulation programmeType,
 * address.countryDescription, the first remark text). Extras are
 * tolerated.
 */
const SAMPLE_EU_XML = `<?xml version="1.0" encoding="UTF-8"?>
<export xmlns="http://eu.europa.eu/sanctions">
  <sanctionEntity logicalId="EU-RU-1234" designationDate="2022-02-25">
    <subjectType code="P" classificationCode="person"/>
    <nameAlias firstName="Ivan" lastName="Petrovich" strong="true"/>
    <nameAlias firstName="John" lastName="Smith" strong="false"/>
    <nameAlias wholeName="I. Petrovich" strong="true"/>
    <regulation regulationType="council_regulation" programmeType="RUS" publicationDate="2022-02-25"/>
    <address city="Moscow" countryDescription="Russian Federation"/>
    <address city="St Petersburg" countryDescription="Russian Federation"/>
    <remark>Designated under EU Regulation 269/2014</remark>
  </sanctionEntity>
  <sanctionEntity logicalId="EU-IRA-99">
    <subjectType code="E" classificationCode="enterprise"/>
    <nameAlias firstName="" lastName="Tehran Holding LLC"/>
    <regulation programmeType="IRA"/>
    <address countryDescription="Iran"/>
  </sanctionEntity>
  <sanctionEntity logicalId="EU-BROKEN" designationDate="2024-01-01">
    <subjectType code="P"/>
    <regulation programmeType="X"/>
  </sanctionEntity>
</export>`;

describe("parseEuSanctionsXml", () => {
  it("extracts persons + entities with the EU source tag", () => {
    const entries = parseEuSanctionsXml(SAMPLE_EU_XML);
    // EU-BROKEN has no nameAlias and is dropped.
    expect(entries).toHaveLength(2);

    const ivan = entries.find((e) => e.uid === "EU-RU-1234");
    expect(ivan).toBeDefined();
    expect(ivan!.sdnType).toBe("individual");
    expect(ivan!.firstName).toBe("Ivan");
    expect(ivan!.lastName).toBe("Petrovich");
    expect(ivan!.programs).toEqual(["RUS"]);
    expect(ivan!.aliases).toEqual(["John Smith", "I. Petrovich"]);
    // De-duplicates the country.
    expect(ivan!.addresses).toEqual(["Russian Federation"]);
    expect(ivan!.sourceList).toBe("EU");
    expect(ivan!.remarks).toBe("Designated under EU Regulation 269/2014");

    const tehran = entries.find((e) => e.uid === "EU-IRA-99");
    expect(tehran!.sdnType).toBe("entity");
    expect(tehran!.lastName).toBe("Tehran Holding LLC");
    expect(tehran!.firstName).toBeUndefined();
    expect(tehran!.programs).toEqual(["IRA"]);
    expect(tehran!.addresses).toEqual(["Iran"]);
  });

  it("decodes XML entities in names + remarks", () => {
    const xml = `
      <export>
        <sanctionEntity logicalId="X1">
          <subjectType code="E"/>
          <nameAlias lastName="Acme &amp; Co. &quot;Special&quot;"/>
          <remark>Notes &lt;internal only&gt;</remark>
        </sanctionEntity>
      </export>`;
    const [entry] = parseEuSanctionsXml(xml);
    expect(entry!.lastName).toBe(`Acme & Co. "Special"`);
    expect(entry!.remarks).toBe("Notes <internal only>");
  });

  it("falls back to wholeName when first/last are absent", () => {
    const xml = `
      <export>
        <sanctionEntity logicalId="W1">
          <subjectType code="E"/>
          <nameAlias wholeName="Just A Whole Name Inc"/>
        </sanctionEntity>
      </export>`;
    const [entry] = parseEuSanctionsXml(xml);
    expect(entry!.lastName).toBe("Just A Whole Name Inc");
    expect(entry!.firstName).toBeUndefined();
  });

  it("skips entities missing a recognizable name", () => {
    const xml = `
      <export>
        <sanctionEntity logicalId="DROP">
          <subjectType code="P"/>
          <regulation programmeType="X"/>
        </sanctionEntity>
        <sanctionEntity logicalId="KEEP">
          <subjectType code="E"/>
          <nameAlias lastName="Real Co"/>
        </sanctionEntity>
      </export>`;
    const entries = parseEuSanctionsXml(xml);
    expect(entries).toHaveLength(1);
    expect(entries[0]!.uid).toBe("KEEP");
  });

  it("returns an empty list for malformed input", () => {
    expect(parseEuSanctionsXml("")).toEqual([]);
    expect(parseEuSanctionsXml("<not-xml")).toEqual([]);
    expect(parseEuSanctionsXml("<export></export>")).toEqual([]);
  });
});

describe("EUConsolidatedAdapter", () => {
  function buildAdapter(xml: string): {
    adapter: EUConsolidatedAdapter;
    calls: { count: number };
  } {
    const calls = { count: 0 };
    const adapter = new EUConsolidatedAdapter({
      cacheTtlMs: 1_000_000,
      euXmlUrl: "https://example.test/eu.xml",
      fetchImpl: async () => {
        calls.count++;
        return new Response(xml, { status: 200 });
      },
    });
    return { adapter, calls };
  }

  it("returns an exact match at score 1.0", async () => {
    const { adapter } = buildAdapter(SAMPLE_EU_XML);
    const entries = await adapter.getEntries();
    const results = adapter.screen("Tehran Holding LLC", entries);
    expect(results).toHaveLength(1);
    expect(results[0]!.score).toBe(1);
    expect(results[0]!.matchType).toBe("exact");
  });

  it("matches on alias and tags it as alias", async () => {
    const { adapter } = buildAdapter(SAMPLE_EU_XML);
    const entries = await adapter.getEntries();
    const results = adapter.screen("I. Petrovich", entries, 0.85);
    expect(results.length).toBeGreaterThan(0);
    expect(results[0]!.matchType).toBe("alias");
    expect(results[0]!.matchedName).toBe("I. Petrovich");
  });

  it("honors the threshold", async () => {
    const { adapter } = buildAdapter(SAMPLE_EU_XML);
    const entries = await adapter.getEntries();
    expect(adapter.screen("Completely Unrelated GmbH", entries, 0.95)).toEqual(
      [],
    );
  });

  it("caches the parsed entries for its TTL", async () => {
    const { adapter, calls } = buildAdapter(SAMPLE_EU_XML);
    const a = await adapter.getEntries();
    const b = await adapter.getEntries();
    expect(calls.count).toBe(1);
    expect(a).toBe(b);
  });
});
