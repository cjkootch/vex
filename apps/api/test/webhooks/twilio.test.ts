import { afterEach, describe, expect, it } from "vitest";
import { getExpectedTwilioSignature } from "twilio/lib/webhooks/webhooks.js";
import {
  TEST_RESEND_SECRET,
  TEST_TWILIO_AUTH_TOKEN,
  buildTestApp,
  type TestAppHandles,
} from "./helpers.js";

const TEST_HOST = "vex.test";

function buildTwilioRequest(params: Record<string, string>): {
  body: string;
  headers: Record<string, string>;
} {
  const body = new URLSearchParams(params).toString();
  // Twilio computes its signature against the *full* URL, so we construct
  // the same URL the controller will reconstruct from headers + path.
  const url = `https://${TEST_HOST}/webhooks/twilio`;
  const signature = getExpectedTwilioSignature(TEST_TWILIO_AUTH_TOKEN, url, params);
  return {
    body,
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      host: TEST_HOST,
      "x-forwarded-proto": "https",
      "x-twilio-signature": signature,
    },
  };
}

describe("POST /webhooks/twilio", () => {
  let handles: TestAppHandles | undefined;

  afterEach(async () => {
    if (handles) await handles.close();
    handles = undefined;
  });

  const params = {
    AccountSid: "ACtest0000000000000000000000000000",
    CallSid: "CA1111111111111111111111111111aaaa",
    CallStatus: "completed",
    From: "+15551234567",
    To: "+15557654321",
    Direction: "outbound-api",
    CallDuration: "187",
  };

  it("accepts a validly-signed request, persists raw_event, enqueues a job", async () => {
    handles = await buildTestApp({
      resendSecret: TEST_RESEND_SECRET,
      twilioAuthToken: TEST_TWILIO_AUTH_TOKEN,
    });
    const { body, headers } = buildTwilioRequest(params);

    const response = await handles.app.inject({
      method: "POST",
      url: "/webhooks/twilio",
      headers,
      payload: body,
    });

    expect(response.statusCode).toBe(204);
    expect(handles.rawEventRepo.calls).toHaveLength(1);
    expect(handles.rawEventRepo.calls[0]![1]).toBe("twilio");
    expect(handles.rawEventRepo.calls[0]![2]).toBe(`${params.CallSid}:completed`);
    expect(handles.queue.calls).toHaveLength(1);
  });

  it("rejects an invalid signature with 400 and does not persist", async () => {
    handles = await buildTestApp({
      resendSecret: TEST_RESEND_SECRET,
      twilioAuthToken: TEST_TWILIO_AUTH_TOKEN,
    });
    const { body, headers } = buildTwilioRequest(params);
    headers["x-twilio-signature"] = "definitely-not-a-real-signature";

    const response = await handles.app.inject({
      method: "POST",
      url: "/webhooks/twilio",
      headers,
      payload: body,
    });

    expect(response.statusCode).toBe(400);
    expect(handles.rawEventRepo.calls).toHaveLength(0);
    expect(handles.queue.calls).toHaveLength(0);
  });
});
