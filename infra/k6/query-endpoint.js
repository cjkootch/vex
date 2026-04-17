import http from "k6/http";
import { check } from "k6";

/**
 * Query (LLM) endpoint load test.
 *
 * SLO: p95 < 5s at 50 concurrent queries. Every request triggers an
 * embedding call + Claude completion + retrieval, so this load test is
 * intentionally expensive — run it against a dedicated Neon branch and
 * a scratch Anthropic key.
 *
 * Required env:
 *   BASE_URL         base URL of apps/api
 *   QUERY_BEARER     Bearer token (NextAuth JWE) for an eval tenant
 *
 * Usage:
 *   k6 run --vus 50 --duration 60s infra/k6/query-endpoint.js
 */

const BASE_URL = __ENV.BASE_URL || "http://localhost:3000";
const TOKEN = __ENV.QUERY_BEARER;

if (!TOKEN) {
  throw new Error("QUERY_BEARER env is required for the query load test");
}

export const options = {
  vus: 50,
  duration: "60s",
  thresholds: {
    http_req_failed: ["rate<0.02"],
    http_req_duration: ["p(95)<5000"],
  },
};

const PROMPTS = [
  "Summarise Acme Corp's last three touchpoints.",
  "Which contacts at Acme are highest priority?",
  "List Acme's open follow-ups.",
  "What was the last email campaign we sent to Acme?",
  "Give me a call prep for the Acme CTO.",
];

export default function () {
  const message = PROMPTS[Math.floor(Math.random() * PROMPTS.length)];
  const res = http.post(
    `${BASE_URL}/query`,
    JSON.stringify({ message }),
    {
      headers: {
        authorization: `Bearer ${TOKEN}`,
        "content-type": "application/json",
      },
      timeout: "20s",
    },
  );

  check(res, {
    "status 2xx": (r) => r.status >= 200 && r.status < 300,
    "non-empty answer": (r) => {
      try {
        const body = JSON.parse(r.body);
        return typeof body.answer === "string" && body.answer.length > 0;
      } catch {
        return false;
      }
    },
  });
}
