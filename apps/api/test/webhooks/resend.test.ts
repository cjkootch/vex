import { afterEach, describe, expect, it } from "vitest";
import { signResendForTest } from "../../src/webhooks/resend-verifier.js";
import {
  TEST_RESEND_SECRET,
  TEST_TWILIO_AUTH_TOKEN,
  buildTestApp,
  type TestAppHandles,
} from "./helpers.js";

describe("POST /webhooks/resend", () => {
  let handles: TestAppHandles | undefined;

  afterEach(async () => {
    if (handles) await handles.close();
    handles = undefined;
  });

  const samplePayload = {
    type: "email.clicked",
    created_at: "2026-04-15T13:42:11.000Z",
    data: {
      to: ["contact1@example1.test"],
      from: "outbound@vexhq.ai",
      subject: "Vex pipeline brief",
      tags: [{ name: "campaign_id", value: "01HSEEDCMP0000000000000001" }],
      click: { link: "https://vexhq.ai/demo" },
    },
  };

  it("accepts a validly-signed payload, persists raw_event, enqueues a job", async () => {
    handles = await buildTestApp({
      resendSecret: TEST_RESEND_SECRET,
      twilioAuthToken: TEST_TWILIO_AUTH_TOKEN,
    });
    const body = Buffer.from(JSON.stringify(samplePayload));
    const headers = signResendForTest(TEST_RESEND_SECRET, body, { id: "msg_test_unique_1" });

    const response = await handles.app.inject({
      method: "POST",
      url: "/webhooks/resend",
      headers: { "content-type": "application/json", ...headers },
      payload: body,
    });

    expect(response.statusCode).toBe(204);
    expect(handles.rawEventRepo.calls).toHaveLength(1);
    const insertArgs = handles.rawEventRepo.calls[0]!;
    expect(insertArgs[1]).toBe("resend");
    expect(insertArgs[2]).toBe("msg_test_unique_1");
    expect(handles.queue.calls).toHaveLength(1);
    expect(handles.queue.calls[0]!.jobId).toBe(handles.queue.calls[0]!.data.raw_event_id);
  });

  it("rejects an invalid signature with 400 and does not persist", async () => {
    handles = await buildTestApp({
      resendSecret: TEST_RESEND_SECRET,
      twilioAuthToken: TEST_TWILIO_AUTH_TOKEN,
    });
    const body = Buffer.from(JSON.stringify(samplePayload));
    const headers = signResendForTest(TEST_RESEND_SECRET, body, { id: "msg_test_2" });
    headers["svix-signature"] = "v1,deadbeef";

    const response = await handles.app.inject({
      method: "POST",
      url: "/webhooks/resend",
      headers: { "content-type": "application/json", ...headers },
      payload: body,
    });

    expect(response.statusCode).toBe(400);
    expect(handles.rawEventRepo.calls).toHaveLength(0);
    expect(handles.queue.calls).toHaveLength(0);
  });

  it("treats a duplicate svix-id as a no-op (no second job enqueued)", async () => {
    handles = await buildTestApp({
      resendSecret: TEST_RESEND_SECRET,
      twilioAuthToken: TEST_TWILIO_AUTH_TOKEN,
    });
    const body = Buffer.from(JSON.stringify(samplePayload));
    const headers = signResendForTest(TEST_RESEND_SECRET, body, { id: "msg_dup_3" });

    handles.rawEventRepo.nextResult = {
      id: "01HSEEDRAWdup0000000000001",
      isNew: false,
    };

    const response = await handles.app.inject({
      method: "POST",
      url: "/webhooks/resend",
      headers: { "content-type": "application/json", ...headers },
      payload: body,
    });

    expect(response.statusCode).toBe(204);
    expect(handles.rawEventRepo.calls).toHaveLength(1);
    expect(handles.queue.calls).toHaveLength(0);
  });
});
