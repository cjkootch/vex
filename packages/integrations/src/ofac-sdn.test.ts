import { describe, expect, it } from "vitest";
import {
  OFACSdnAdapter,
  jaroWinkler,
  parseSdnXml,
  type SdnEntry,
} from "./ofac-sdn.js";

const SAMPLE_XML = `<?xml version="1.0" standalone="yes"?>
<sdnList>
  <sdnEntry>
    <uid>12345</uid>
    <firstName>Juan</firstName>
    <lastName>Rodriguez</lastName>
    <sdnType>individual</sdnType>
    <programList>
      <program>CUBA</program>
      <program>SDGT</program>
    </programList>
    <akaList>
      <aka>
        <uid>99</uid>
        <type>a.k.a.</type>
        <category>strong</category>
        <firstName>John</firstName>
        <lastName>Rodriguez</lastName>
      </aka>
    </akaList>
    <addressList>
      <address>
        <uid>1</uid>
        <country>Cuba</country>
      </address>
    </addressList>
    <remarks>DOB 1 Jan 1970</remarks>
  </sdnEntry>
  <sdnEntry>
    <uid>67890</uid>
    <lastName>Acme Trading Ltd &amp; Co.</lastName>
    <sdnType>entity</sdnType>
    <programList>
      <program>IRAN</program>
    </programList>
  </sdnEntry>
</sdnList>`;

describe("parseSdnXml", () => {
  it("extracts individuals with programs, aliases, addresses, remarks", () => {
    const entries = parseSdnXml(SAMPLE_XML);
    expect(entries).toHaveLength(2);
    const person = entries[0]!;
    expect(person).toMatchObject({
      uid: "12345",
      firstName: "Juan",
      lastName: "Rodriguez",
      sdnType: "individual",
      programs: ["CUBA", "SDGT"],
      aliases: ["John Rodriguez"],
      addresses: ["Cuba"],
      remarks: "DOB 1 Jan 1970",
    });
  });

  it("decodes XML entities in entity names", () => {
    const entries = parseSdnXml(SAMPLE_XML);
    expect(entries[1]!.lastName).toBe("Acme Trading Ltd & Co.");
    expect(entries[1]!.programs).toEqual(["IRAN"]);
  });

  it("skips entries missing required fields", () => {
    const broken = `<sdnList>
      <sdnEntry>
        <firstName>Missing</firstName>
        <lastName>Uid</lastName>
      </sdnEntry>
    </sdnList>`;
    expect(parseSdnXml(broken)).toEqual([]);
  });
});

describe("jaroWinkler", () => {
  it("returns 1 for identical strings", () => {
    expect(jaroWinkler("fidel", "fidel")).toBe(1);
  });

  it("returns 0 for fully disjoint strings", () => {
    expect(jaroWinkler("abc", "xyz")).toBe(0);
  });

  it("scores typos above the screening threshold", () => {
    // Typo of one character — commonly tested sanctions-screening input.
    expect(jaroWinkler("rodriguez", "rodrigues")).toBeGreaterThan(0.9);
  });

  it("rewards shared prefix (Winkler bonus)", () => {
    const withPrefix = jaroWinkler("martinezq", "martinezx");
    const withoutPrefix = jaroWinkler("qmartinez", "xmartinez");
    expect(withPrefix).toBeGreaterThan(withoutPrefix);
  });
});

describe("OFACSdnAdapter", () => {
  function entry(partial: Partial<SdnEntry>): SdnEntry {
    return {
      uid: "1",
      lastName: "X",
      sdnType: "individual",
      programs: [],
      aliases: [],
      addresses: [],
      ...partial,
    };
  }

  it("returns an exact match at score 1.0", () => {
    const adapter = new OFACSdnAdapter();
    const entries = [
      entry({ firstName: "Juan", lastName: "Rodriguez" }),
      entry({ lastName: "Other Entity" }),
    ];
    const results = adapter.screen("Juan Rodriguez", entries);
    expect(results).toHaveLength(1);
    expect(results[0]!.score).toBe(1);
    expect(results[0]!.matchType).toBe("exact");
  });

  it("matches on alias when the legal name doesn't fire", () => {
    const adapter = new OFACSdnAdapter();
    const entries = [
      entry({
        firstName: "Juan",
        lastName: "Rodriguez",
        aliases: ["El Jefe"],
      }),
    ];
    const results = adapter.screen("El Jefe", entries);
    expect(results).toHaveLength(1);
    expect(results[0]!.matchType).toBe("alias");
  });

  it("honors the threshold", () => {
    const adapter = new OFACSdnAdapter();
    const entries = [entry({ firstName: "Juan", lastName: "Rodriguez" })];
    const loose = adapter.screen("Juan Rodriguez", entries, 0.5);
    const strict = adapter.screen("Completely Different Name", entries, 0.9);
    expect(loose).toHaveLength(1);
    expect(strict).toHaveLength(0);
  });

  it("sorts results by score descending", () => {
    const adapter = new OFACSdnAdapter();
    const entries = [
      entry({ uid: "a", lastName: "Smith" }),
      entry({ uid: "b", firstName: "John", lastName: "Smith" }),
    ];
    const results = adapter.screen("John Smith", entries, 0.7);
    expect(results[0]!.entry.uid).toBe("b");
  });

  it("caches the parsed entries for its TTL", async () => {
    let calls = 0;
    const adapter = new OFACSdnAdapter({
      cacheTtlMs: 1_000_000,
      sdnXmlUrl: "https://example.test/sdn.xml",
      fetchImpl: async () => {
        calls++;
        return new Response(SAMPLE_XML, { status: 200 });
      },
    });
    const a = await adapter.getEntries();
    const b = await adapter.getEntries();
    expect(calls).toBe(1);
    expect(a).toBe(b);
  });
});
