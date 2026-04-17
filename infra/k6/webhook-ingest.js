import http from "k6/http";
import { check } from "k6";
import crypto from "k6/crypto";
import encoding from "k6/encoding";

/**
 * Webhook ingest load test.
 *
 * SLO: p99 < 200ms with 500 concurrent requests. The API verifies the
 * signature, writes a row to `raw_events`, and enqueues a normalization
 * job — everything else is async.
 *
 * Required env:
 *   BASE_URL                 base URL of apps/api (no trailing slash)
 *   RESEND_WEBHOOK_SECRET    Svix-format secret, `whsec_<base64>`
 *
 * Usage:
 *   k6 run --vus 500 --duration 60s infra/k6/webhook-ingest.js
 */

const BASE_URL = __ENV.BASE_URL || "http://localhost:3000";
const RAW_SECRET =
  __ENV.RESEND_WEBHOOK_SECRET || "whsec_dGVzdC1zZWNyZXQtYnl0ZXMtMTIzNDU2Nzg5MGFiY2RlZg==";

export const options = {
  vus: 500,
  duration: "60s",
  thresholds: {
    http_req_failed: ["rate<0.005"],
    http_req_duration: ["p(99)<200"],
  },
};

// Decode the `whsec_<base64>` secret once per VU.
const secretBytes = encoding.b64decode(RAW_SECRET.replace(/^whsec_/, ""), "std");

function svixSign(msgId, timestamp, body) {
  const toSign = `${msgId}.${timestamp}.${body}`;
  const mac = crypto.hmac("sha256", secretBytes, toSign, "base64");
  return `v1,${mac}`;
}

export default function () {
  const now = Math.floor(Date.now() / 1000);
  const msgId = `msg_${__VU}_${__ITER}`;
  const body = JSON.stringify({
    type: "email.delivered",
    created_at: new Date().toISOString(),
    data: {
      email_id: `em_${__VU}_${__ITER}`,
      to: ["loadtest@example.invalid"],
      subject: "load test",
    },
  });
  const signature = svixSign(msgId, now, body);

  const res = http.post(`${BASE_URL}/webhooks/resend`, body, {
    headers: {
      "content-type": "application/json",
      "svix-id": msgId,
      "svix-timestamp": `${now}`,
      "svix-signature": signature,
    },
  });

  check(res, {
    "ingest 2xx": (r) => r.status >= 200 && r.status < 300,
  });
}
