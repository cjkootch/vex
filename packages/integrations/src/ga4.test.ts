import { generateKeyPairSync } from "node:crypto";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { GA4Adapter } from "./ga4.js";
import { __resetGoogleAuthCache } from "./google-auth.js";

let FAKE_SA: { client_email: string; private_key: string };
beforeAll(() => {
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const pem = privateKey.export({ type: "pkcs8", format: "pem" }) as string;
  FAKE_SA = {
    client_email: "vex-test@example.iam.gserviceaccount.com",
    private_key: pem,
  };
});

const FAKE_REPORT = {
  dimensionHeaders: [{ name: "sessionSource" }, { name: "date" }],
  metricHeaders: [{ name: "sessions", type: "TYPE_INTEGER" }],
  rows: [
    {
      dimensionValues: [{ value: "google" }, { value: "20260801" }],
      metricValues: [{ value: "42" }],
    },
  ],
  rowCount: 1,
};

describe("GA4Adapter", () => {
  beforeEach(() => {
    __resetGoogleAuthCache();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("runReport returns a correctly shaped GA4Report", async () => {
    const fetcher = vi.fn(async (url: string) => {
      if (url.includes("oauth2.googleapis.com/token")) {
        return new Response(
          JSON.stringify({ access_token: "test-token", expires_in: 3600 }),
          { status: 200 },
        );
      }
      if (url.includes(":runReport")) {
        return new Response(JSON.stringify(FAKE_REPORT), { status: 200 });
      }
      throw new Error(`unexpected url ${url}`);
    });

    const adapter = new GA4Adapter({
      serviceAccount: FAKE_SA,
      fetchImpl: fetcher as unknown as typeof fetch,
    });
    const report = await adapter.runReport(
      "1234",
      ["sessionSource", "date"],
      ["sessions"],
      { startDate: "7daysAgo", endDate: "today" },
    );
    expect(report.metricHeaders[0]?.name).toBe("sessions");
    expect(report.rows[0]?.metricValues[0]?.value).toBe("42");
    expect(fetcher).toHaveBeenCalledTimes(2); // token + report
  });

  it("retries on 429 with exponential backoff", async () => {
    let attempt = 0;
    const fetcher = vi.fn(async (url: string) => {
      if (url.includes("oauth2.googleapis.com/token")) {
        return new Response(
          JSON.stringify({ access_token: "t", expires_in: 3600 }),
          { status: 200 },
        );
      }
      attempt++;
      if (attempt < 3) {
        return new Response("rate limited", { status: 429 });
      }
      return new Response(JSON.stringify(FAKE_REPORT), { status: 200 });
    });
    const sleeps: number[] = [];
    const adapter = new GA4Adapter({
      serviceAccount: FAKE_SA,
      fetchImpl: fetcher as unknown as typeof fetch,
      sleepImpl: async (ms) => {
        sleeps.push(ms);
      },
    });
    const report = await adapter.runReport(
      "p",
      ["sessionSource"],
      ["sessions"],
      { startDate: "7daysAgo", endDate: "today" },
    );
    expect(report.rows).toHaveLength(1);
    expect(sleeps).toEqual([1000, 2000]);
  });

  it("throws on non-2xx non-429", async () => {
    const fetcher = vi.fn(async (url: string) => {
      if (url.includes("oauth2.googleapis.com/token")) {
        return new Response(
          JSON.stringify({ access_token: "t", expires_in: 3600 }),
          { status: 200 },
        );
      }
      return new Response("nope", { status: 403 });
    });
    const adapter = new GA4Adapter({
      serviceAccount: FAKE_SA,
      fetchImpl: fetcher as unknown as typeof fetch,
    });
    await expect(
      adapter.runReport("p", ["a"], ["sessions"], {
        startDate: "7daysAgo",
        endDate: "today",
      }),
    ).rejects.toThrow(/ga4 403/);
  });
});
