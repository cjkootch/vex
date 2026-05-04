import { describe, expect, it } from "vitest";
import {
  renderTemplatesPreamble,
  substituteTemplate,
  extractPlaceholders,
  assertNoUnresolvedPlaceholders,
  UnresolvedTemplateVariablesError,
} from "./templates.js";

describe("substituteTemplate", () => {
  it("replaces named placeholders", () => {
    const out = substituteTemplate("Hi {{recipient_name}}, deal {{deal_ref}}", {
      recipient_name: "Cole",
      deal_ref: "VTC-2026-003",
    });
    expect(out).toBe("Hi Cole, deal VTC-2026-003");
  });

  it("tolerates whitespace inside braces", () => {
    expect(substituteTemplate("{{ name }}", { name: "Cole" })).toBe("Cole");
  });

  it("leaves unknown placeholders intact for operator review", () => {
    const out = substituteTemplate("Hi {{recipient_name}}", {});
    expect(out).toBe("Hi {{recipient_name}}");
  });

  it("ignores braces with non-identifier contents", () => {
    expect(substituteTemplate("price {{ $50 }}", {})).toBe("price {{ $50 }}");
  });
});

describe("extractPlaceholders", () => {
  it("collects unique placeholder names", () => {
    expect(
      extractPlaceholders("{{a}} and {{b}} and {{a}}"),
    ).toEqual(["a", "b"]);
  });

  it("returns empty for plain text", () => {
    expect(extractPlaceholders("hello")).toEqual([]);
  });
});

describe("renderTemplatesPreamble", () => {
  it("returns empty string when all three lists are empty", () => {
    expect(renderTemplatesPreamble(null, null, null)).toBe("");
    expect(renderTemplatesPreamble([], [], [])).toBe("");
    expect(renderTemplatesPreamble(undefined, undefined, undefined)).toBe("");
  });

  it("renders an email template with subject + body + variables", () => {
    const out = renderTemplatesPreamble(
      [
        {
          name: "welcome",
          subject: "Welcome {{recipient_name}}",
          body: "Hi {{recipient_name}}, glad to meet you.",
          description: "First-touch intro after a discovery call.",
          variables: ["recipient_name"],
        },
      ],
      null,
      null,
    );
    expect(out).toContain("### Email templates");
    expect(out).toContain("welcome");
    expect(out).toContain("Welcome {{recipient_name}}");
    expect(out).toContain("Use when: First-touch intro");
    expect(out).toContain("Variables: recipient_name");
  });

  it("renders sms + call templates with their kind-specific fields", () => {
    const out = renderTemplatesPreamble(
      null,
      [
        {
          name: "deal_ready",
          body: "Hi {{recipient_name}}, deal {{deal_ref}} is ready to sign.",
          variables: ["recipient_name", "deal_ref"],
        },
      ],
      [
        {
          name: "bl_followup",
          aiInstructions:
            "You are Vex calling on behalf of VTC. Ask {{recipient_name}} when the BL for deal {{deal_ref}} will issue.",
          goal_hint: "Confirm BL issuance ETA",
          variables: ["recipient_name", "deal_ref"],
        },
      ],
    );
    expect(out).toContain("### SMS templates");
    expect(out).toContain("deal_ready");
    expect(out).toContain("### AI-call templates");
    expect(out).toContain("bl_followup");
    expect(out).toContain("Goal: Confirm BL issuance ETA");
  });

  it("collapses multi-line bodies to one line in the preamble", () => {
    const out = renderTemplatesPreamble(
      [
        {
          name: "x",
          subject: "s",
          body: "line one\nline two\n\nline three",
        },
      ],
      null,
      null,
    );
    expect(out).toContain("Body: line one line two line three");
    expect(out).not.toMatch(/Body: line one\nline two/);
  });

  it("explains the opt-in nature so the model doesn't substitute templates silently", () => {
    const out = renderTemplatesPreamble(
      [{ name: "x", subject: "s", body: "b" }],
      null,
      null,
    );
    expect(out).toContain("OPT-IN");
    expect(out).toContain("freeform");
  });
});

describe("assertNoUnresolvedPlaceholders", () => {
  it("returns silently when all placeholders are resolved", () => {
    expect(() =>
      assertNoUnresolvedPlaceholders("Hi Cole", "Body for Cole"),
    ).not.toThrow();
  });

  it("returns silently for plain text with no placeholders", () => {
    expect(() =>
      assertNoUnresolvedPlaceholders("hello world"),
    ).not.toThrow();
  });

  it("throws UnresolvedTemplateVariablesError listing all unresolved names", () => {
    let caught: unknown = null;
    try {
      assertNoUnresolvedPlaceholders(
        "Hi {{recipient_name}}",
        "Call about {{call_topic}} at {{proposed_windows}}",
      );
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(UnresolvedTemplateVariablesError);
    const e = caught as UnresolvedTemplateVariablesError;
    expect(e.variables).toEqual([
      "call_topic",
      "proposed_windows",
      "recipient_name",
    ]);
    expect(e.message).toContain("call_topic");
    expect(e.message).toContain("proposed_windows");
  });

  it("dedupes the unresolved-variable list across multiple input strings", () => {
    let caught: unknown = null;
    try {
      assertNoUnresolvedPlaceholders(
        "Hi {{recipient_name}}",
        "Goodbye {{recipient_name}}",
      );
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(UnresolvedTemplateVariablesError);
    expect((caught as UnresolvedTemplateVariablesError).variables).toEqual([
      "recipient_name",
    ]);
  });

  it("handles no inputs cleanly (vacuous truth — nothing to assert)", () => {
    expect(() => assertNoUnresolvedPlaceholders()).not.toThrow();
  });
});
