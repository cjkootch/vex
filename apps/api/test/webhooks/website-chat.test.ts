import { afterEach, describe, expect, it } from "vitest";
import { signWebsiteChatForTest } from "../../src/webhooks/website-chat-verifier.js";
import {
  TEST_RESEND_SECRET,
  TEST_TWILIO_AUTH_TOKEN,
  TEST_WEBSITE_CHAT_SECRET,
  buildTestApp,
  type TestAppHandles,
} from "./helpers.js";

describe("POST /webhooks/website-chat", () => {
  let handles: TestAppHandles | undefined;

  afterEach(async () => {
    if (handles) await handles.close();
    handles = undefined;
  });

  const startedPayload = {
    event: "conversation.started",
    conversation_id: "vtc-1775761482261-k3x9f2m7a",
    website_version: "abc1234",
    timestamp: "2026-04-19T22:00:00.000Z",
    lead: { name: "Jane Doe", email: "jane@acme.example" },
    page: {
      url: "https://vectortradecapital.com/fuel",
      referrer: "https://google.com/",
      utm: { source: "google", medium: "cpc" },
    },
  };

  const endedPayload = {
    event: "conversation.ended",
    conversation_id: "vtc-1775761482261-k3x9f2m7a",
    website_version: "abc1234",
    timestamp: "2026-04-19T22:05:00.000Z",
    lead: { name: "Jane Doe", email: "jane@acme.example" },
    page: { url: "https://vectortradecapital.com/fuel" },
    messages: [
      { role: "user", text: "Need 200kMT of rice CIF Kingston", ts: "2026-04-19T22:01:00Z" },
      { role: "assistant", text: "Happy to help. What's your timeline?", ts: "2026-04-19T22:01:10Z" },
    ],
  };

  it("accepts a validly-signed started event and enqueues a normalization job", async () => {
    handles = await buildTestApp({
      resendSecret: TEST_RESEND_SECRET,
      twilioAuthToken: TEST_TWILIO_AUTH_TOKEN,
    });
    const body = Buffer.from(JSON.stringify(startedPayload));
    const headers = signWebsiteChatForTest(TEST_WEBSITE_CHAT_SECRET, body);

    const response = await handles.app.inject({
      method: "POST",
      url: "/webhooks/website-chat",
      headers: { "content-type": "application/json", ...headers },
      payload: body,
    });

    expect(response.statusCode).toBe(204);
    expect(handles.rawEventRepo.calls).toHaveLength(1);
    const insertArgs = handles.rawEventRepo.calls[0]!;
    // (tx, tenantId, provider, providerEventId, headers, payload, checksum)
    expect(insertArgs[2]).toBe("website_chat");
    expect(insertArgs[3]).toBe(
      "vtc-1775761482261-k3x9f2m7a:conversation.started",
    );
    expect(handles.queue.calls).toHaveLength(1);
  });

  it("accepts a validly-signed ended event with a distinct providerEventId", async () => {
    handles = await buildTestApp({
      resendSecret: TEST_RESEND_SECRET,
      twilioAuthToken: TEST_TWILIO_AUTH_TOKEN,
    });
    const body = Buffer.from(JSON.stringify(endedPayload));
    const headers = signWebsiteChatForTest(TEST_WEBSITE_CHAT_SECRET, body);

    const response = await handles.app.inject({
      method: "POST",
      url: "/webhooks/website-chat",
      headers: { "content-type": "application/json", ...headers },
      payload: body,
    });

    expect(response.statusCode).toBe(204);
    expect(handles.rawEventRepo.calls[0]![3]).toBe(
      "vtc-1775761482261-k3x9f2m7a:conversation.ended",
    );
  });

  it("rejects a bad signature with 400 and does not persist", async () => {
    handles = await buildTestApp({
      resendSecret: TEST_RESEND_SECRET,
      twilioAuthToken: TEST_TWILIO_AUTH_TOKEN,
    });
    const body = Buffer.from(JSON.stringify(startedPayload));
    const headers = signWebsiteChatForTest(TEST_WEBSITE_CHAT_SECRET, body);
    headers["x-vtc-signature"] = "deadbeef";

    const response = await handles.app.inject({
      method: "POST",
      url: "/webhooks/website-chat",
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
      JSON.stringify({ ...startedPayload, event: "conversation.pinged" }),
    );
    const headers = signWebsiteChatForTest(TEST_WEBSITE_CHAT_SECRET, body);

    const response = await handles.app.inject({
      method: "POST",
      url: "/webhooks/website-chat",
      headers: { "content-type": "application/json", ...headers },
      payload: body,
    });

    expect(response.statusCode).toBe(400);
    expect(handles.rawEventRepo.calls).toHaveLength(0);
    expect(handles.queue.calls).toHaveLength(0);
  });

  it("dedupes repeat deliveries of the same conversation+event", async () => {
    handles = await buildTestApp({
      resendSecret: TEST_RESEND_SECRET,
      twilioAuthToken: TEST_TWILIO_AUTH_TOKEN,
    });
    const body = Buffer.from(JSON.stringify(startedPayload));
    const headers = signWebsiteChatForTest(TEST_WEBSITE_CHAT_SECRET, body);

    handles.rawEventRepo.nextResult = {
      id: "01HSEEDRAW_dup00000000000001",
      isNew: false,
    };

    const response = await handles.app.inject({
      method: "POST",
      url: "/webhooks/website-chat",
      headers: { "content-type": "application/json", ...headers },
      payload: body,
    });

    expect(response.statusCode).toBe(204);
    expect(handles.rawEventRepo.calls).toHaveLength(1);
    expect(handles.queue.calls).toHaveLength(0);
  });
});
