import http from "k6/http";
import { check, sleep } from "k6";

/**
 * Health-check load test.
 *
 * SLO: p99 < 50ms at 1000 rps sustained. The endpoint is unauthenticated,
 * in-process only (no DB call), so anything above 50ms is process-level
 * latency we care about.
 *
 * Usage:
 *   BASE_URL=https://api.vex.local k6 run infra/k6/health-check.js
 *
 * Tune VUs/duration on the CLI:
 *   k6 run --vus 200 --duration 60s infra/k6/health-check.js
 */

const BASE_URL = __ENV.BASE_URL || "http://localhost:3000";

export const options = {
  // Ramp to 1000 rps in 30s, hold for 60s, ramp down.
  scenarios: {
    steady: {
      executor: "constant-arrival-rate",
      rate: 1000,
      timeUnit: "1s",
      duration: "60s",
      preAllocatedVUs: 200,
      maxVUs: 400,
    },
  },
  thresholds: {
    http_req_failed: ["rate<0.001"],
    http_req_duration: ["p(99)<50"],
  },
};

export default function () {
  const res = http.get(`${BASE_URL}/health`, {
    headers: { accept: "application/json" },
  });
  check(res, {
    "status 200": (r) => r.status === 200,
    "service vex-api": (r) => {
      try {
        return JSON.parse(r.body).service === "vex-api";
      } catch {
        return false;
      }
    },
  });
  sleep(0);
}
