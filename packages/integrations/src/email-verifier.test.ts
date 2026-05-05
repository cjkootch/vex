import { describe, expect, it } from "vitest";
import {
  emailSyntaxValid,
  extractDomain,
  verifyEmail,
} from "./email-verifier.js";

describe("emailSyntaxValid", () => {
  it("accepts canonical B2B addresses", () => {
    expect(emailSyntaxValid("cole@vectortradecapital.com")).toBe(true);
    expect(emailSyntaxValid("first.last@example.co.uk")).toBe(true);
    expect(emailSyntaxValid("buyer+rfq@vitol.com")).toBe(true);
    expect(emailSyntaxValid("a@b.co")).toBe(true);
  });

  it("rejects obvious typos", () => {
    expect(emailSyntaxValid("not-an-email")).toBe(false);
    expect(emailSyntaxValid("missing@tld")).toBe(false);
    expect(emailSyntaxValid("@example.com")).toBe(false);
    expect(emailSyntaxValid("user@")).toBe(false);
    expect(emailSyntaxValid("user@@example.com")).toBe(false);
    expect(emailSyntaxValid("")).toBe(false);
  });

  it("rejects non-strings + over-long inputs", () => {
    expect(emailSyntaxValid(undefined as unknown as string)).toBe(false);
    expect(emailSyntaxValid(null as unknown as string)).toBe(false);
    expect(emailSyntaxValid("a".repeat(400) + "@example.com")).toBe(false);
  });

  it("trims surrounding whitespace before checking", () => {
    expect(emailSyntaxValid("  cole@example.com  ")).toBe(true);
  });
});

describe("extractDomain", () => {
  it("returns the domain in lowercase", () => {
    expect(extractDomain("Cole@Example.COM")).toBe("example.com");
  });

  it("returns null when there's no @", () => {
    expect(extractDomain("plain")).toBeNull();
  });

  it("returns null when @ is at edges", () => {
    expect(extractDomain("@example.com")).toBeNull();
    expect(extractDomain("user@")).toBeNull();
  });
});

describe("verifyEmail", () => {
  it("returns syntax_invalid for malformed addresses", async () => {
    const out = await verifyEmail("not-an-email");
    expect(out.verdict).toBe("syntax_invalid");
    expect(out.domain).toBeNull();
  });

  it("returns valid when MX records resolve", async () => {
    const resolveMx = async () => [
      { exchange: "mail.example.com", priority: 10 },
    ];
    const out = await verifyEmail("cole@example.com", { resolveMx });
    expect(out.verdict).toBe("valid");
    expect(out.domain).toBe("example.com");
    expect(out.reason).toContain("1 MX record");
  });

  it("returns domain_unreachable when MX resolves to empty array", async () => {
    const resolveMx = async () => [];
    const out = await verifyEmail("cole@notrealdomain123.xyz", { resolveMx });
    expect(out.verdict).toBe("domain_unreachable");
    expect(out.domain).toBe("notrealdomain123.xyz");
  });

  it("returns domain_unreachable on ENOTFOUND", async () => {
    const resolveMx = async () => {
      throw Object.assign(new Error("nope"), { code: "ENOTFOUND" });
    };
    const out = await verifyEmail("cole@gone.example", { resolveMx });
    expect(out.verdict).toBe("domain_unreachable");
    expect(out.reason).toContain("ENOTFOUND");
  });

  it("returns domain_unreachable on ENODATA", async () => {
    const resolveMx = async () => {
      throw Object.assign(new Error("nope"), { code: "ENODATA" });
    };
    const out = await verifyEmail("cole@neverhad.example", { resolveMx });
    expect(out.verdict).toBe("domain_unreachable");
  });

  it("returns dns_error (not domain_unreachable) on transient DNS failures", async () => {
    // Per the comment in email-verifier.ts: only ENOTFOUND/ENODATA
    // are definitive. Other errors are infra issues; DON'T refuse
    // the send (would self-DOS).
    const resolveMx = async () => {
      throw Object.assign(new Error("temp fail"), { code: "ESERVFAIL" });
    };
    const out = await verifyEmail("cole@example.com", { resolveMx });
    expect(out.verdict).toBe("dns_error");
  });

  it("treats DNS timeout as dns_error, not refusal", async () => {
    const resolveMx = () =>
      new Promise<Array<{ exchange: string; priority: number }>>(() => {
        // never resolves
      });
    const out = await verifyEmail("cole@example.com", {
      resolveMx,
      timeoutMs: 50,
    });
    expect(out.verdict).toBe("dns_error");
    expect(out.reason).toContain("dns_timeout");
  });
});
