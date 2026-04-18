import { describe, expect, it, vi } from "vitest";
import { EiaAdapter, FUEL_SERIES } from "./eia.js";

function jsonResponse(body: unknown, init: { status?: number; statusText?: string } = {}): Response {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    statusText: init.statusText ?? "OK",
    headers: { "content-type": "application/json" },
  });
}

describe("EiaAdapter", () => {
  it("builds the v2 URL with the series filter, date window, and api_key", async () => {
    const fetchImpl = vi.fn(async (): Promise<Response> =>
      jsonResponse({ response: { data: [] } }),
    );
    const adapter = new EiaAdapter({ apiKey: "test-key", fetch: fetchImpl });
    await adapter.fetchSeries({ seriesId: FUEL_SERIES.WTI, start: "2026-04-10", end: "2026-04-17" });

    const urlCalled = fetchImpl.mock.calls[0]![0] as string;
    const url = new URL(urlCalled);
    expect(url.host).toBe("api.eia.gov");
    expect(url.pathname).toBe(`/v2/seriesid/${encodeURIComponent(FUEL_SERIES.WTI)}/data/`);
    expect(url.searchParams.get("api_key")).toBe("test-key");
    expect(url.searchParams.get("start")).toBe("2026-04-10");
    expect(url.searchParams.get("end")).toBe("2026-04-17");
    expect(url.searchParams.getAll("facets[series][]")).toEqual([FUEL_SERIES.WTI]);
  });

  it("uses weekly frequency for .W series and daily for .D series", async () => {
    const captured: string[] = [];
    const fetchImpl = vi.fn(async (url: unknown): Promise<Response> => {
      captured.push(String(url));
      return jsonResponse({ response: { data: [] } });
    });
    const adapter = new EiaAdapter({ apiKey: "k", fetch: fetchImpl });
    await adapter.fetchSeries({ seriesId: "PET.FOO.D", start: "2026-04-10", end: "2026-04-17" });
    await adapter.fetchSeries({ seriesId: "PET.FOO.W", start: "2026-04-10", end: "2026-04-17" });
    expect(new URL(captured[0]!).searchParams.get("frequency")).toBe("daily");
    expect(new URL(captured[1]!).searchParams.get("frequency")).toBe("weekly");
  });

  it("coerces string values, nullifies the EIA '.' placeholder, and preserves numeric values", async () => {
    const fetchImpl = vi.fn(async (): Promise<Response> =>
      jsonResponse({
        response: {
          data: [
            { period: "2026-04-17", value: "84.25", units: "dollars per barrel" },
            { period: "2026-04-16", value: ".", units: "dollars per barrel" },
            { period: "2026-04-15", value: 82.5, units: "dollars per barrel" },
            { period: "2026-04-14", value: "not-a-number", units: "dollars per barrel" },
          ],
        },
      }),
    );
    const adapter = new EiaAdapter({ apiKey: "k", fetch: fetchImpl });
    const rows = await adapter.fetchSeries({ seriesId: "PET.RWTC.D", start: "2026-04-14", end: "2026-04-17" });

    expect(rows).toHaveLength(4);
    expect(rows[0]).toEqual({ seriesId: "PET.RWTC.D", period: "2026-04-17", value: 84.25, unit: "dollars per barrel" });
    expect(rows[1]?.value).toBe(null);
    expect(rows[2]?.value).toBe(82.5);
    expect(rows[3]?.value).toBe(null);
  });

  it("throws on a non-2xx HTTP response so the agent can record a fetch_failed event", async () => {
    const fetchImpl = vi.fn(async (): Promise<Response> =>
      new Response("rate limited", { status: 429, statusText: "Too Many Requests" }),
    );
    const adapter = new EiaAdapter({ apiKey: "k", fetch: fetchImpl });
    await expect(
      adapter.fetchSeries({ seriesId: "PET.RWTC.D", start: "2026-04-17", end: "2026-04-17" }),
    ).rejects.toThrow(/429/);
  });

  it("throws when the EIA payload reports an error even with a 200 status", async () => {
    const fetchImpl = vi.fn(async (): Promise<Response> =>
      jsonResponse({ error: "Invalid series id" }),
    );
    const adapter = new EiaAdapter({ apiKey: "k", fetch: fetchImpl });
    await expect(
      adapter.fetchSeries({ seriesId: "PET.BAD.D", start: "2026-04-17", end: "2026-04-17" }),
    ).rejects.toThrow(/Invalid series id/);
  });

  it("drops rows without a period field (malformed response)", async () => {
    const fetchImpl = vi.fn(async (): Promise<Response> =>
      jsonResponse({ response: { data: [{ value: "80.0", units: "$/bbl" }] } }),
    );
    const adapter = new EiaAdapter({ apiKey: "k", fetch: fetchImpl });
    const rows = await adapter.fetchSeries({ seriesId: "PET.RWTC.D", start: "2026-04-17", end: "2026-04-17" });
    expect(rows).toEqual([]);
  });
});
