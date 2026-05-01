import { describe, expect, it } from "vitest";
import { renderWhatsAppTemplatesPreamble } from "./whatsapp-templates.js";

describe("renderWhatsAppTemplatesPreamble", () => {
  it("returns empty string for null / undefined / empty", () => {
    expect(renderWhatsAppTemplatesPreamble(null)).toBe("");
    expect(renderWhatsAppTemplatesPreamble(undefined)).toBe("");
    expect(renderWhatsAppTemplatesPreamble([])).toBe("");
  });

  it("renders a single template with description + variables", () => {
    const out = renderWhatsAppTemplatesPreamble([
      {
        name: "welcome_check_in",
        contentSid: "HX0123456789abcdef0123456789abcdef",
        description: "Friendly intro saying we're checking in.",
        variables: ["recipient_name", "deal_ref"],
      },
    ]);
    expect(out).toContain("WhatsApp Business templates");
    expect(out).toContain("welcome_check_in");
    expect(out).toContain("HX0123456789abcdef0123456789abcdef");
    expect(out).toContain("Friendly intro");
    // Variables rendered with 1-based indices matching Twilio's {{N}}.
    expect(out).toContain("{{1}} = recipient_name");
    expect(out).toContain("{{2}} = deal_ref");
  });

  it("renders templates without optional fields", () => {
    const out = renderWhatsAppTemplatesPreamble([
      {
        name: "ping",
        contentSid: "HXaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      },
    ]);
    expect(out).toContain("ping");
    expect(out).not.toContain("Description:");
    expect(out).not.toContain("Variables:");
  });

  it("renders multiple templates as a list", () => {
    const out = renderWhatsAppTemplatesPreamble([
      { name: "a", contentSid: "HXaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" },
      { name: "b", contentSid: "HXbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" },
    ]);
    expect(out.match(/^- \*\*/gm)?.length).toBe(2);
  });

  it("explains the cold-outreach use case so the model picks templates over freeform", () => {
    const out = renderWhatsAppTemplatesPreamble([
      { name: "x", contentSid: "HXaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" },
    ]);
    expect(out).toContain("63016");
    expect(out).toContain("24h");
    expect(out).toContain("whatsapp.send_template");
  });
});
