import { afterEach, describe, expect, it } from "vitest";
import { signWebsiteChatForTest } from "../../src/webhooks/website-chat-verifier.js";
import {
  TEST_RESEND_SECRET,
  TEST_TWILIO_AUTH_TOKEN,
  TEST_WEBSITE_CHAT_SECRET,
  buildTestApp,
  type TestAppHandles,
} from "./helpers.js";

describe("POST /webhooks/email-inbound", () => {
  let handles: TestAppHandles | undefined;

  afterEach(async () => {
    if (handles) await handles.close();
    handles = undefined;
  });

  const payload = {
    event: "email.received",
    from: "sales@rice-corp.com",
    to: ["rfq@vexhq.ai"],
    subject: "Re: RFQ — 500 MT rice into Port-au-Prince (Q3 2026)",
    text: "Yes, we have 500MT parboiled. Laycan May 15-20, Kingston. LC30D. CIF $580/MT.",
    message_id: "<abc-123@mail.rice-corp.com>",
    in_reply_to: "<re_8d0xyz@resend.dev>",
    received_at: "2026-04-20T18:30:00.000Z",
  };

  it("accepts a validly-signed email.received event and enqueues a normalization job", async () => {
    handles = await buildTestApp({
      resendSecret: TEST_RESEND_SECRET,
      twilioAuthToken: TEST_TWILIO_AUTH_TOKEN,
    });
    const body = Buffer.from(JSON.stringify(payload));
    const headers = signWebsiteChatForTest(TEST_WEBSITE_CHAT_SECRET, body);

    const response = await handles.app.inject({
      method: "POST",
      url: "/webhooks/email-inbound",
      headers: { "content-type": "application/json", ...headers },
      payload: body,
    });

    expect(response.statusCode).toBe(204);
    expect(handles.rawEventRepo.calls).toHaveLength(1);
    const insertArgs = handles.rawEventRepo.calls[0]!;
    // (tx, tenantId, provider, providerEventId, headers, payload, checksum)
    expect(insertArgs[2]).toBe("email_inbound");
    expect(insertArgs[3]).toBe("<abc-123@mail.rice-corp.com>");
    expect(handles.queue.calls).toHaveLength(1);
  });

  it("rejects a bad signature with 400 and does not persist", async () => {
    handles = await buildTestApp({
      resendSecret: TEST_RESEND_SECRET,
      twilioAuthToken: TEST_TWILIO_AUTH_TOKEN,
    });
    const body = Buffer.from(JSON.stringify(payload));
    const headers = signWebsiteChatForTest(TEST_WEBSITE_CHAT_SECRET, body);
    headers["x-vtc-signature"] = "deadbeef";

    const response = await handles.app.inject({
      method: "POST",
      url: "/webhooks/email-inbound",
      headers: { "content-type": "application/json", ...headers },
      payload: body,
    });

    expect(response.statusCode).toBe(400);
    expect(handles.rawEventRepo.calls).toHaveLength(0);
    expect(handles.queue.calls).toHaveLength(0);
  });

  it("rejects an unsupported event kind", async () => {
    handles = await buildTestApp({
      resendSecret: TEST_RESEND_SECRET,
      twilioAuthToken: TEST_TWILIO_AUTH_TOKEN,
    });
    const body = Buffer.from(
      JSON.stringify({ ...payload, event: "email.viewed" }),
    );
    const headers = signWebsiteChatForTest(TEST_WEBSITE_CHAT_SECRET, body);

    const response = await handles.app.inject({
      method: "POST",
      url: "/webhooks/email-inbound",
      headers: { "content-type": "application/json", ...headers },
      payload: body,
    });

    expect(response.statusCode).toBe(400);
    expect(handles.rawEventRepo.calls).toHaveLength(0);
    expect(handles.queue.calls).toHaveLength(0);
  });

  it("rejects a payload missing message_id", async () => {
    handles = await buildTestApp({
      resendSecret: TEST_RESEND_SECRET,
      twilioAuthToken: TEST_TWILIO_AUTH_TOKEN,
    });
    const raw = { ...payload } as Record<string, unknown>;
    delete raw["message_id"];
    const body = Buffer.from(JSON.stringify(raw));
    const headers = signWebsiteChatForTest(TEST_WEBSITE_CHAT_SECRET, body);

    const response = await handles.app.inject({
      method: "POST",
      url: "/webhooks/email-inbound",
      headers: { "content-type": "application/json", ...headers },
      payload: body,
    });

    expect(response.statusCode).toBe(400);
    expect(handles.rawEventRepo.calls).toHaveLength(0);
    expect(handles.queue.calls).toHaveLength(0);
  });

  it("dedupes repeat deliveries of the same Message-ID", async () => {
    handles = await buildTestApp({
      resendSecret: TEST_RESEND_SECRET,
      twilioAuthToken: TEST_TWILIO_AUTH_TOKEN,
    });
    const body = Buffer.from(JSON.stringify(payload));
    const headers = signWebsiteChatForTest(TEST_WEBSITE_CHAT_SECRET, body);

    handles.rawEventRepo.nextResult = {
      id: "01HSEEDRAW_EML_dup_0000000001",
      isNew: false,
    };

    const response = await handles.app.inject({
      method: "POST",
      url: "/webhooks/email-inbound",
      headers: { "content-type": "application/json", ...headers },
      payload: body,
    });

    expect(response.statusCode).toBe(204);
    expect(handles.rawEventRepo.calls).toHaveLength(1);
    expect(handles.queue.calls).toHaveLength(0);
  });
});
