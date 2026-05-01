import { describe, expect, it } from "vitest";
import {
  UKOFSIAdapter,
  parseUkOfsiCsv,
  readCsvRows,
} from "./uk-ofsi.js";

/**
 * Synthetic OFSI CSV fixture. Real exports ship ~30 columns; we
 * test the focused subset the parser consumes (Group ID, Group Type,
 * Alias Type, Regime, Country, Name 1..6). The first non-data line
 * mimics OFSI's "Last Updated:" banner that the parser skips.
 */
const SAMPLE_OFSI_CSV = `Last Updated: 30/04/2026,,,,,,,,,,
Group ID,Group Type,Alias Type,Name 1,Name 2,Name 3,Name 4,Name 5,Name 6,Regime,Country
G100,Individual,,Ivan,Sergeyevich,,,,Petrov,Russia,Russia
G100,Individual,AKA,John,,,,,Smith,Russia,Russia
G100,Individual,AKA,,,,,,I. Petrov,Russia,Russia
G200,Entity,,,,,,,Acme Trading Ltd,Iran,Iran
G300,Ship,,,,,,,"Vessel ""Stormrider""",Counter-Terrorism,
`;

describe("readCsvRows", () => {
  it("handles quoted fields, embedded quotes, and CRLF line endings", () => {
    const csv = `a,b,c\r\n"with, comma","emb""edded",plain\r\n,,\r\n`;
    const rows = readCsvRows(csv);
    // Empty trailing line should be dropped.
    expect(rows).toEqual([
      ["a", "b", "c"],
      ["with, comma", 'emb"edded', "plain"],
    ]);
  });

  it("preserves order of empty cells when between data fields", () => {
    const rows = readCsvRows(`one,,three\n`);
    expect(rows).toEqual([["one", "", "three"]]);
  });
});

describe("parseUkOfsiCsv", () => {
  it("groups rows by Group ID, primary + aliases", () => {
    const entries = parseUkOfsiCsv(SAMPLE_OFSI_CSV);
    // Groups G100, G200, G300.
    expect(entries).toHaveLength(3);

    const ivan = entries.find((e) => e.uid === "G100");
    expect(ivan).toBeDefined();
    expect(ivan!.sdnType).toBe("individual");
    expect(ivan!.lastName).toBe("Petrov");
    expect(ivan!.firstName).toBe("Ivan Sergeyevich");
    expect(ivan!.aliases).toEqual(["John Smith", "I. Petrov"]);
    expect(ivan!.programs).toEqual(["Russia"]);
    expect(ivan!.addresses).toEqual(["Russia"]);
    expect(ivan!.sourceList).toBe("UK_OFSI");

    const acme = entries.find((e) => e.uid === "G200");
    expect(acme!.sdnType).toBe("entity");
    expect(acme!.lastName).toBe("Acme Trading Ltd");
    expect(acme!.firstName).toBeUndefined();

    const ship = entries.find((e) => e.uid === "G300");
    expect(ship!.sdnType).toBe("vessel");
    expect(ship!.lastName).toBe(`Vessel "Stormrider"`);
  });

  it("tolerates the leading 'Last Updated' banner row", () => {
    const csv = `,,,,,,
Some unrelated banner line,,,,,,
Group ID,Group Type,Alias Type,Name 1,Name 2,Name 3,Name 4,Name 5,Name 6,Regime,Country
G1,Entity,,,,,,,Test Co,Russia,
`;
    const entries = parseUkOfsiCsv(csv);
    expect(entries).toHaveLength(1);
    expect(entries[0]!.uid).toBe("G1");
  });

  it("returns an empty list when the header row is missing", () => {
    expect(parseUkOfsiCsv("")).toEqual([]);
    expect(parseUkOfsiCsv("just,plain,text\nrows,with,no,header")).toEqual([]);
  });
});

describe("UKOFSIAdapter", () => {
  function buildAdapter(csv: string): {
    adapter: UKOFSIAdapter;
    calls: { count: number };
  } {
    const calls = { count: 0 };
    const adapter = new UKOFSIAdapter({
      cacheTtlMs: 1_000_000,
      ofsiCsvUrl: "https://example.test/ofsi.csv",
      fetchImpl: async () => {
        calls.count++;
        return new Response(csv, { status: 200 });
      },
    });
    return { adapter, calls };
  }

  it("returns an exact match at score 1.0", async () => {
    const { adapter } = buildAdapter(SAMPLE_OFSI_CSV);
    const entries = await adapter.getEntries();
    const results = adapter.screen("Acme Trading Ltd", entries);
    expect(results).toHaveLength(1);
    expect(results[0]!.score).toBe(1);
    expect(results[0]!.matchType).toBe("exact");
  });

  it("matches on alias", async () => {
    const { adapter } = buildAdapter(SAMPLE_OFSI_CSV);
    const entries = await adapter.getEntries();
    const results = adapter.screen("John Smith", entries, 0.85);
    expect(results.length).toBeGreaterThan(0);
    expect(results[0]!.matchType).toBe("alias");
  });

  it("caches the parsed entries for its TTL", async () => {
    const { adapter, calls } = buildAdapter(SAMPLE_OFSI_CSV);
    const a = await adapter.getEntries();
    const b = await adapter.getEntries();
    expect(calls.count).toBe(1);
    expect(a).toBe(b);
  });
});
