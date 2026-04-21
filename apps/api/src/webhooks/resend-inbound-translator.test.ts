import { describe, expect, it } from "vitest";
import { translateResendInbound } from "./resend-inbound-translator.js";

describe("translateResendInbound", () => {
  it("translates a typical Resend Inbound payload to canonical shape", () => {
    const out = translateResendInbound({
      type: "email.received",
      created_at: "2026-04-21T17:30:00Z",
      data: {
        from: "Cole Kutschinski <cole@vectortradecapital.com>",
        to: ["vector@vexhq.ai"],
        subject: "Re: Caribbean fuel supply",
        text: "Thanks, let's schedule a call.",
        html: "<p>Thanks, let's schedule a call.</p>",
        headers: [
          { name: "Message-ID", value: "<abc@mail.gmail.com>" },
          { name: "In-Reply-To", value: "<outbound@resend.dev>" },
        ],
        email_id: "inb_abc",
      },
    });
    expect("error" in out).toBe(false);
    if ("error" in out) return;
    expect(out).toMatchObject({
      event: "email.received",
      to: ["vector@vexhq.ai"],
      subject: "Re: Caribbean fuel supply",
      text: "Thanks, let's schedule a call.",
      message_id: "<abc@mail.gmail.com>",
      in_reply_to: "<outbound@resend.dev>",
      received_at: "2026-04-21T17:30:00Z",
    });
    // "Cole Kutschinski <cole@...>" isn't a bare email — the translator
    // falls back to extracting the {email} key if from is an object.
    // When it's a bracketed display-name string, we keep what we got
    // lowercased + trimmed; the normalizer's zod `.email()` check will
    // reject shapes we can't cleanly parse.
    expect(out.from).toContain("cole@vectortradecapital.com");
  });

  it("accepts from/to as {email, name} objects", () => {
    const out = translateResendInbound({
      type: "email.received",
      data: {
        from: { email: "cole@example.com", name: "Cole K" },
        to: [{ email: "vector@vexhq.ai", name: "Vector" }],
        subject: "hi",
        text: "hi back",
        headers: { "message-id": "<msg1@x>" },
      },
    });
    expect("error" in out).toBe(false);
    if ("error" in out) return;
    expect(out.from).toBe("cole@example.com");
    expect(out.to).toEqual(["vector@vexhq.ai"]);
    expect(out.message_id).toBe("<msg1@x>");
  });

  it("accepts headers as a {k: v} object", () => {
    const out = translateResendInbound({
      type: "email.received",
      data: {
        from: "a@b.com",
        to: ["vector@vexhq.ai"],
        headers: {
          "Message-ID": "<msg2@x>",
          "In-Reply-To": "<out@y>",
        },
      },
    });
    expect("error" in out).toBe(false);
    if ("error" in out) return;
    expect(out.message_id).toBe("<msg2@x>");
    expect(out.in_reply_to).toBe("<out@y>");
  });

  it("falls back to email_id when headers lack Message-ID", () => {
    const out = translateResendInbound({
      type: "email.received",
      data: {
        from: "a@b.com",
        to: ["vector@vexhq.ai"],
        email_id: "inb_fallback",
      },
    });
    expect("error" in out).toBe(false);
    if ("error" in out) return;
    expect(out.message_id).toBe("inb_fallback");
  });

  it("rejects unsupported event types", () => {
    const out = translateResendInbound({
      type: "email.delivered",
      data: { from: "a@b.com", to: ["v@x.com"] },
    });
    expect("error" in out).toBe(true);
  });

  it("rejects when from is missing", () => {
    const out = translateResendInbound({
      type: "email.received",
      data: { to: ["v@x.com"], email_id: "inb_1" },
    });
    expect("error" in out).toBe(true);
  });

  it("rejects when message_id can't be derived", () => {
    const out = translateResendInbound({
      type: "email.received",
      data: {
        from: "a@b.com",
        to: ["v@x.com"],
        // no email_id, no headers with Message-ID
      },
    });
    expect("error" in out).toBe(true);
  });
});
