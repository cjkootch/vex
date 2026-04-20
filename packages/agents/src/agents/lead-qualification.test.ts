import { describe, expect, it } from "vitest";
import { extractDraftReply, isHotSignal } from "./lead-qualification.js";

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
