import { describe, expect, it } from "vitest";
import {
  buildDefaultSignature,
  renderEmailWithSignature,
} from "./email-format.js";

describe("renderEmailWithSignature", () => {
  it("appends the explicit text signature after a '-- ' delimiter", () => {
    const out = renderEmailWithSignature({
      body: "Hi Priya,\n\nConfirming our Q3 ULSD conversation.",
      signature: { text: "Cole\nVTC" },
    });
    expect(out.text).toBe(
      "Hi Priya,\n\nConfirming our Q3 ULSD conversation.\n\n-- \nCole\nVTC",
    );
  });

  it("wraps body paragraphs in <p>, preserves line breaks via <br/>", () => {
    const out = renderEmailWithSignature({
      body: "Hi Priya,\nshort line\n\nNext para.",
      signature: {},
    });
    expect(out.html).toContain("<p");
    expect(out.html).toContain("Hi Priya,<br/>short line");
    // Two paragraphs -> two <p> tags
    expect((out.html.match(/<p\s/g) ?? []).length).toBe(2);
  });

  it("renders a hairline + signature block in HTML when signature.html is set", () => {
    const out = renderEmailWithSignature({
      body: "Hi.",
      signature: { html: '<div style="font-weight:600">Cole</div>' },
    });
    expect(out.html).toContain("border-top:1px solid");
    expect(out.html).toContain("Cole");
  });

  it("escapes body HTML characters (defence in depth)", () => {
    const out = renderEmailWithSignature({
      body: "Need <script>alert(1)</script> & rice",
      signature: {},
    });
    expect(out.html).toContain("&lt;script&gt;");
    expect(out.html).not.toContain("<script>");
    expect(out.html).toContain("&amp;");
  });

  it("falls back to defaults when signature.html/text are absent or empty", () => {
    const out = renderEmailWithSignature({
      body: "Hi.",
      signature: { html: "", text: "" },
      defaults: { html: "<div>Default</div>", text: "Default Co." },
    });
    expect(out.text).toContain("\n\n-- \nDefault Co.");
    expect(out.html).toContain("Default");
  });

  it("emits a bare body when no signature + no defaults", () => {
    const out = renderEmailWithSignature({ body: "Hi." });
    expect(out.text).toBe("Hi.");
    expect(out.html).toContain("<p");
    expect(out.html).not.toContain("-- ");
    expect(out.html).not.toContain("border-top");
  });

  it("trims body whitespace before rendering", () => {
    const out = renderEmailWithSignature({
      body: "\n\n  Hi Priya,\n\n\n",
      signature: { text: "Cole" },
    });
    expect(out.text.startsWith("Hi Priya,")).toBe(true);
    expect(out.text.endsWith("Cole")).toBe(true);
  });
});

describe("buildDefaultSignature", () => {
  it("renders name + title + company + contact + website", () => {
    const sig = buildDefaultSignature({
      fullName: "Cole Kootch",
      title: "Principal",
      companyName: "Vector Trade Capital",
      email: "cole@vectortradecapital.com",
      phone: "+1 877 549 4685",
      websiteUrl: "vectortradecapital.com",
    });
    expect(sig.text).toContain("Cole Kootch");
    expect(sig.text).toContain("Principal");
    expect(sig.text).toContain("Vector Trade Capital");
    expect(sig.text).toContain("+1 877 549 4685");
    expect(sig.text).toContain("cole@vectortradecapital.com");
    expect(sig.html).toContain("font-weight:600");
    expect(sig.html).toContain('href="mailto:cole@vectortradecapital.com"');
    expect(sig.html).toContain('href="tel:+18775494685"');
    expect(sig.html).toContain('href="https://vectortradecapital.com"');
  });

  it("omits lines whose fields are absent", () => {
    const sig = buildDefaultSignature({ companyName: "VTC" });
    expect(sig.text).toBe("VTC");
    expect(sig.html).toContain("VTC");
    expect(sig.html).not.toContain("mailto:");
    expect(sig.html).not.toContain("tel:");
  });

  it("emits an empty signature when given nothing", () => {
    const sig = buildDefaultSignature({});
    expect(sig.text).toBeUndefined();
    expect(sig.html).toBeUndefined();
  });

  it("promotes bare-domain websites to https://", () => {
    const sig = buildDefaultSignature({
      fullName: "A",
      websiteUrl: "example.com",
    });
    expect(sig.html).toContain('href="https://example.com"');
  });
});
