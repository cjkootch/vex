import { describe, expect, it } from "vitest";
import {
  CSLAdapter,
  parseCslJson,
  type CslEntry,
} from "./csl.js";

/**
 * Minimal CSL snapshot fixture. Real trade.gov payloads are larger
 * but use the same field names — `results[]` with `id`, `name`,
 * `alt_names[]`, `addresses[]`, `type`, `programs[]`, `source` /
 * `source_short_name`. We test the fields we actually consume; the
 * adapter is intentionally tolerant of extras.
 */
const SAMPLE_CSL = {
  sources_used: [
    {
      source: "Specially Designated Nationals (SDN) - Treasury Department",
      source_short_name: "SDN",
      source_last_imported: "2026-04-30T00:00:00Z",
    },
  ],
  results: [
    {
      id: "ofac-12345",
      name: "Acme Trading Ltd",
      alt_names: ["Acme Trading", "ACME Co."],
      addresses: [{ country: "Iran" }, { country: "Iran" }],
      type: "Entity",
      programs: ["IRAN", "SDGT"],
      remarks: "Front company per OFAC remarks",
      source: "Specially Designated Nationals (SDN) - Treasury Department",
      source_short_name: "SDN",
    },
    {
      id: "bis-el-77",
      name: "Sigma Robotics Co.",
      alt_names: ["Sigma Robotics"],
      addresses: [{ country: "China" }],
      type: "Entity",
      programs: ["EAR99"],
      source: "Entity List - Bureau of Industry and Security",
      source_short_name: "EL",
    },
    {
      id: "uvl-91",
      first_name: "John",
      name: "Doe",
      type: "Individual",
      programs: [],
      source: "Unverified List - Bureau of Industry and Security",
      source_short_name: "UVL",
    },
  ],
};

describe("parseCslJson", () => {
  it("parses entities + individuals with the source-list tag", () => {
    const entries = parseCslJson(SAMPLE_CSL);
    expect(entries).toHaveLength(3);

    const acme = entries.find((e) => e.uid === "ofac-12345");
    expect(acme).toBeDefined();
    expect(acme!.lastName).toBe("Acme Trading Ltd");
    expect(acme!.sdnType).toBe("entity");
    expect(acme!.programs).toEqual(["IRAN", "SDGT"]);
    expect(acme!.aliases).toEqual(["Acme Trading", "ACME Co."]);
    // De-duplicates the country.
    expect(acme!.addresses).toEqual(["Iran"]);
    expect(acme!.sourceList).toBe("SDN");
    expect(acme!.remarks).toBe("Front company per OFAC remarks");

    const sigma = entries.find((e) => e.uid === "bis-el-77");
    expect(sigma!.sourceList).toBe("EL");

    const doe = entries.find((e) => e.uid === "uvl-91");
    expect(doe!.firstName).toBe("John");
    expect(doe!.sdnType).toBe("individual");
    expect(doe!.sourceList).toBe("UVL");
  });

  it("falls back to the long-form source description when short_name is missing", () => {
    const json = {
      results: [
        {
          id: "x",
          name: "Some Co",
          type: "Entity",
          source:
            "Denied Persons List (DPL) - Bureau of Industry and Security",
        },
      ],
    };
    const [entry] = parseCslJson(json);
    expect(entry!.sourceList).toBe("DPL");
  });

  it("collapses unknown sources to OTHER rather than dropping the row", () => {
    const json = {
      results: [
        {
          id: "y",
          name: "Mystery Inc",
          type: "Entity",
          source: "Brand-New Sanctions List That Trade.gov Just Added",
        },
      ],
    };
    const [entry] = parseCslJson(json);
    expect(entry).toBeDefined();
    expect(entry!.sourceList).toBe("OTHER");
  });

  it("skips rows missing required fields (id, name, recognised type)", () => {
    const json = {
      results: [
        // Missing id.
        { name: "X", type: "Entity" },
        // Missing name.
        { id: "1", type: "Entity" },
        // Unknown type.
        { id: "2", name: "Y", type: "ufo" },
        // Valid — keeps us honest that the parser hasn't broken.
        { id: "3", name: "Z", type: "Entity" },
      ],
    };
    const entries = parseCslJson(json);
    expect(entries).toHaveLength(1);
    expect(entries[0]!.uid).toBe("3");
  });

  it("returns an empty list for malformed input", () => {
    expect(parseCslJson(null)).toEqual([]);
    expect(parseCslJson("string")).toEqual([]);
    expect(parseCslJson({ results: "not an array" })).toEqual([]);
  });
});

describe("CSLAdapter", () => {
  function buildAdapter(json: unknown): {
    adapter: CSLAdapter;
    calls: { count: number };
  } {
    const calls = { count: 0 };
    const adapter = new CSLAdapter({
      cacheTtlMs: 1_000_000,
      cslJsonUrl: "https://example.test/csl.json",
      fetchImpl: async () => {
        calls.count++;
        return new Response(JSON.stringify(json), { status: 200 });
      },
    });
    return { adapter, calls };
  }

  it("returns an exact match at score 1.0 (entity)", async () => {
    const { adapter } = buildAdapter(SAMPLE_CSL);
    const entries = await adapter.getEntries();
    const results = adapter.screen("Acme Trading Ltd", entries);
    expect(results).toHaveLength(1);
    expect(results[0]!.score).toBe(1);
    expect(results[0]!.matchType).toBe("exact");
    const entry = results[0]!.entry as CslEntry;
    expect(entry.sourceList).toBe("SDN");
  });

  it("surfaces a BIS Entity List hit with the EL source tag", async () => {
    const { adapter } = buildAdapter(SAMPLE_CSL);
    const entries = await adapter.getEntries();
    const results = adapter.screen("Sigma Robotics Co.", entries);
    const top = results[0];
    expect(top).toBeDefined();
    expect((top!.entry as CslEntry).sourceList).toBe("EL");
  });

  it("matches on alias when the legal name doesn't fire", async () => {
    const { adapter } = buildAdapter(SAMPLE_CSL);
    const entries = await adapter.getEntries();
    const results = adapter.screen("ACME Co.", entries, 0.85);
    const top = results[0];
    expect(top).toBeDefined();
    expect(top!.matchType).toBe("alias");
    expect(top!.matchedName).toBe("ACME Co.");
  });

  it("honors the threshold", async () => {
    const { adapter } = buildAdapter(SAMPLE_CSL);
    const entries = await adapter.getEntries();
    expect(adapter.screen("Completely Different LLC", entries, 0.95)).toEqual(
      [],
    );
  });

  it("caches the parsed entries for its TTL", async () => {
    const { adapter, calls } = buildAdapter(SAMPLE_CSL);
    const a = await adapter.getEntries();
    const b = await adapter.getEntries();
    expect(calls.count).toBe(1);
    expect(a).toBe(b);
  });
});
