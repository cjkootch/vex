import { afterEach, describe, expect, it } from "vitest";
import { signWebsiteChatForTest } from "../../src/webhooks/website-chat-verifier.js";
import {
  TEST_RESEND_SECRET,
  TEST_TWILIO_AUTH_TOKEN,
  TEST_WEBSITE_CHAT_SECRET,
  buildTestApp,
  type TestAppHandles,
} from "./helpers.js";

describe("POST /webhooks/form", () => {
  let handles: TestAppHandles | undefined;

  afterEach(async () => {
    if (handles) await handles.close();
    handles = undefined;
  });

  const formPayload = {
    event: "form.submitted",
    form_id: "lead-form",
    form_name: "Request a Quote",
    website_version: "c31e5ce",
    timestamp: "2026-04-20T18:00:00.000Z",
    lead: {
      name: "Jean-Marie Baptiste",
      email: "jm@acmeimports.ht",
      phone: "+509-3444-5555",
      sms_consent: true,
    },
    fields: {
      country: "Haiti",
      product_interest: "food",
      message:
        "Need 500 MT parboiled rice CIF Port-au-Prince, Q3 2026",
    },
    page: {
      url: "https://vectortradecapital.com/#contact",
      referrer: "https://google.com/",
      utm: { source: "google", medium: "cpc", campaign: "q2-haiti" },
    },
  };

  it("accepts a validly-signed form.submitted event and enqueues a normalization job", async () => {
    handles = await buildTestApp({
      resendSecret: TEST_RESEND_SECRET,
      twilioAuthToken: TEST_TWILIO_AUTH_TOKEN,
    });
    const body = Buffer.from(JSON.stringify(formPayload));
    const headers = signWebsiteChatForTest(TEST_WEBSITE_CHAT_SECRET, body);

    const response = await handles.app.inject({
      method: "POST",
      url: "/webhooks/form",
      headers: { "content-type": "application/json", ...headers },
      payload: body,
    });

    expect(response.statusCode).toBe(204);
    expect(handles.rawEventRepo.calls).toHaveLength(1);
    const insertArgs = handles.rawEventRepo.calls[0]!;
    // (tx, tenantId, provider, providerEventId, headers, payload, checksum)
    expect(insertArgs[2]).toBe("website_form");
    expect(insertArgs[3]).toBe(
      "lead-form:jm@acmeimports.ht:2026-04-20T18:00:00.000Z",
    );
    expect(handles.queue.calls).toHaveLength(1);
  });

  it("rejects a bad signature with 400 and does not persist", async () => {
    handles = await buildTestApp({
      resendSecret: TEST_RESEND_SECRET,
      twilioAuthToken: TEST_TWILIO_AUTH_TOKEN,
    });
    const body = Buffer.from(JSON.stringify(formPayload));
    const headers = signWebsiteChatForTest(TEST_WEBSITE_CHAT_SECRET, body);
    headers["x-vtc-signature"] = "deadbeef";

    const response = await handles.app.inject({
      method: "POST",
      url: "/webhooks/form",
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
      JSON.stringify({ ...formPayload, event: "form.viewed" }),
    );
    const headers = signWebsiteChatForTest(TEST_WEBSITE_CHAT_SECRET, body);

    const response = await handles.app.inject({
      method: "POST",
      url: "/webhooks/form",
      headers: { "content-type": "application/json", ...headers },
      payload: body,
    });

    expect(response.statusCode).toBe(400);
    expect(handles.rawEventRepo.calls).toHaveLength(0);
    expect(handles.queue.calls).toHaveLength(0);
  });

  it("rejects a payload missing form_id or lead.email", async () => {
    handles = await buildTestApp({
      resendSecret: TEST_RESEND_SECRET,
      twilioAuthToken: TEST_TWILIO_AUTH_TOKEN,
    });
    const body = Buffer.from(
      JSON.stringify({
        ...formPayload,
        lead: { name: "No Email", phone: "+1-555-0100" },
      }),
    );
    const headers = signWebsiteChatForTest(TEST_WEBSITE_CHAT_SECRET, body);

    const response = await handles.app.inject({
      method: "POST",
      url: "/webhooks/form",
      headers: { "content-type": "application/json", ...headers },
      payload: body,
    });

    expect(response.statusCode).toBe(400);
    expect(handles.rawEventRepo.calls).toHaveLength(0);
    expect(handles.queue.calls).toHaveLength(0);
  });

  it("dedupes repeat deliveries of the same submission", async () => {
    handles = await buildTestApp({
      resendSecret: TEST_RESEND_SECRET,
      twilioAuthToken: TEST_TWILIO_AUTH_TOKEN,
    });
    const body = Buffer.from(JSON.stringify(formPayload));
    const headers = signWebsiteChatForTest(TEST_WEBSITE_CHAT_SECRET, body);

    handles.rawEventRepo.nextResult = {
      id: "01HSEEDRAW_dup00000000000099",
      isNew: false,
    };

    const response = await handles.app.inject({
      method: "POST",
      url: "/webhooks/form",
      headers: { "content-type": "application/json", ...headers },
      payload: body,
    });

    expect(response.statusCode).toBe(204);
    expect(handles.rawEventRepo.calls).toHaveLength(1);
    expect(handles.queue.calls).toHaveLength(0);
  });
});
