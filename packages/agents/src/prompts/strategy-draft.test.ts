import { describe, expect, it } from "vitest";
import {
  buildStrategyDraftUserMessage,
  parseStrategyDraft,
  slotKind,
  type StrategyDraftEvidence,
} from "./strategy-draft.js";

const EMPTY_EVIDENCE: StrategyDraftEvidence = {
  org_counts: {
    buyer: 0,
    supplier: 0,
    broker: 0,
    buyer_broker: 0,
    internal: 0,
    competitor: 0,
  },
  top_products: [],
  active_deal_count: 0,
  recent_destinations: [],
};

describe("slotKind", () => {
  it("classifies each slot as text or list", () => {
    expect(slotKind("mission")).toBe("text");
    expect(slotKind("target_markets")).toBe("list");
    expect(slotKind("icp_buyers")).toBe("text");
    expect(slotKind("no_go_zones")).toBe("list");
    expect(slotKind("growth_priorities")).toBe("list");
    expect(slotKind("additional_guidance")).toBe("text");
  });
});

describe("parseStrategyDraft", () => {
  describe("text slots", () => {
    it("accepts a clean text draft", () => {
      const out = parseStrategyDraft(
        "mission",
        JSON.stringify({ draft: "Do the thing." }),
      );
      expect(out).toEqual({ ok: true, draft: "Do the thing." });
    });

    it("trims whitespace", () => {
      const out = parseStrategyDraft(
        "mission",
        '{"draft": "  Padded.  "}',
      );
      expect(out).toEqual({ ok: true, draft: "Padded." });
    });

    it("rejects an empty text draft", () => {
      const out = parseStrategyDraft("mission", '{"draft": ""}');
      expect(out).toEqual({ ok: false, reason: "expected_non_empty_string" });
    });

    it("rejects a list-shaped draft for a text slot", () => {
      const out = parseStrategyDraft(
        "mission",
        '{"draft": ["not", "text"]}',
      );
      expect(out).toEqual({ ok: false, reason: "expected_non_empty_string" });
    });

    it("tolerates prose around the JSON object", () => {
      const out = parseStrategyDraft(
        "mission",
        'Here is my draft:\n{"draft": "Do the thing."}\nThanks.',
      );
      expect(out).toEqual({ ok: true, draft: "Do the thing." });
    });
  });

  describe("list slots", () => {
    it("accepts a clean list draft", () => {
      const out = parseStrategyDraft(
        "target_markets",
        JSON.stringify({ draft: ["Jamaica", "Trinidad"] }),
      );
      expect(out).toEqual({ ok: true, draft: ["Jamaica", "Trinidad"] });
    });

    it("trims + drops non-strings and empty entries", () => {
      const out = parseStrategyDraft(
        "no_go_zones",
        JSON.stringify({ draft: ["  Cuba  ", "", null, 42, "Iran"] }),
      );
      expect(out).toEqual({ ok: true, draft: ["Cuba", "Iran"] });
    });

    it("rejects an empty array", () => {
      const out = parseStrategyDraft(
        "no_go_zones",
        JSON.stringify({ draft: [] }),
      );
      expect(out).toEqual({ ok: false, reason: "empty_array" });
    });

    it("rejects a text-shaped draft for a list slot", () => {
      const out = parseStrategyDraft(
        "no_go_zones",
        JSON.stringify({ draft: "Cuba, Iran" }),
      );
      expect(out).toEqual({ ok: false, reason: "expected_array" });
    });
  });

  describe("parser error handling", () => {
    it("rejects non-JSON input", () => {
      const out = parseStrategyDraft("mission", "hello there, no JSON here");
      expect(out).toEqual({ ok: false, reason: "no_json_object" });
    });

    it("rejects malformed JSON", () => {
      const out = parseStrategyDraft("mission", "{draft: 'bad'}");
      expect(out).toEqual({ ok: false, reason: "invalid_json" });
    });

    it("rejects an array at the root", () => {
      // Parser looks for the first { and last }, so an array-only
      // payload fails the `no_json_object` check.
      const out = parseStrategyDraft("mission", JSON.stringify(["a", "b"]));
      expect(out).toEqual({ ok: false, reason: "no_json_object" });
    });
  });
});

describe("buildStrategyDraftUserMessage", () => {
  it("mentions the slot, its kind, the evidence, and existing strategy", () => {
    const msg = buildStrategyDraftUserMessage(
      "icp_buyers",
      {
        ...EMPTY_EVIDENCE,
        active_deal_count: 5,
        top_products: [{ product: "rice", deal_count: 3 }],
      },
      { mission: "Do the thing." },
      null,
    );
    expect(msg).toContain("Slot: icp_buyers");
    expect(msg).toContain("Slot kind: text");
    expect(msg).toContain('"active_deal_count": 5');
    expect(msg).toContain('"product": "rice"');
    expect(msg).toContain("Do the thing.");
    expect(msg).toContain('Return { "draft": "<text>" }.');
  });

  it("includes operator hints when provided, omits the block when null/empty", () => {
    const withHints = buildStrategyDraftUserMessage(
      "target_markets",
      EMPTY_EVIDENCE,
      {},
      "focus on Caribbean bunkering",
    );
    expect(withHints).toContain("Operator hints");
    expect(withHints).toContain("focus on Caribbean bunkering");

    const noHints = buildStrategyDraftUserMessage(
      "target_markets",
      EMPTY_EVIDENCE,
      {},
      null,
    );
    expect(noHints).not.toContain("Operator hints");
  });

  it("strips meta fields from existing strategy", () => {
    const msg = buildStrategyDraftUserMessage(
      "mission",
      EMPTY_EVIDENCE,
      {
        mission: "Keep it",
        updated_at: "2026-04-20T00:00:00Z",
        updated_by: "user-1",
      },
      null,
    );
    expect(msg).toContain("Keep it");
    expect(msg).not.toContain("updated_at");
    expect(msg).not.toContain("user-1");
  });

  it("uses the list return hint for list slots", () => {
    const msg = buildStrategyDraftUserMessage(
      "no_go_zones",
      EMPTY_EVIDENCE,
      {},
      null,
    );
    expect(msg).toContain('Return { "draft": ["<entry>", ...] }.');
  });
});
