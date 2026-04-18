import { NextResponse, type NextRequest } from "next/server";
import { buildUpstreamHeaders } from "@/lib/upstream-headers";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * GET /api/market/rates — proxy to apps/api `GET /market/rates`. Forwards
 * `product`, `since`, and `limit` query params. When `VEX_API_URL` is
 * unset, returns a seeded 5-row snapshot so the MarketIntelPanel renders
 * in local dev without a running API.
 */
export async function GET(req: NextRequest): Promise<Response> {
  const upstream = process.env["VEX_API_URL"];
  const incoming = new URL(req.url);

  if (upstream) {
    const forwarded = new URLSearchParams();
    for (const key of ["product", "since", "limit"] as const) {
      const value = incoming.searchParams.get(key);
      if (value) forwarded.set(key, value);
    }
    const qs = forwarded.toString();
    const url = `${upstream.replace(/\/$/, "")}/market/rates${qs ? `?${qs}` : ""}`;
    try {
      const response = await fetch(url, { headers: buildUpstreamHeaders(req) });
      const body = await response.text();
      return new Response(body, {
        status: response.status,
        headers: {
          "content-type":
            response.headers.get("content-type") ?? "application/json",
        },
      });
    } catch (err) {
      return NextResponse.json(
        { error: "upstream_unavailable", message: (err as Error).message },
        { status: 502 },
      );
    }
  }

  return NextResponse.json({ rates: stubRates() });
}

function stubRates() {
  const rateDate = new Date().toISOString().slice(0, 10);
  const createdAt = new Date().toISOString();
  return [
    {
      id: "01HSTUBRATE00000000000WTI",
      rateDate,
      product: "crude",
      benchmark: "WTI",
      pricePerUsg: 1.83,
      pricePerBbl: 76.86,
      pricePerMt: 563.18,
      currency: "usd",
      source: "stub",
      createdAt,
    },
    {
      id: "01HSTUBRATE00000000000BRN",
      rateDate,
      product: "crude",
      benchmark: "BRENT",
      pricePerUsg: 1.94,
      pricePerBbl: 81.48,
      pricePerMt: 597.24,
      currency: "usd",
      source: "stub",
      createdAt,
    },
    {
      id: "01HSTUBRATE00000000000DSL",
      rateDate,
      product: "diesel",
      benchmark: "NY_HARBOR_ULSD",
      pricePerUsg: 2.61,
      pricePerBbl: 109.62,
      pricePerMt: 816.57,
      currency: "usd",
      source: "stub",
      createdAt,
    },
    {
      id: "01HSTUBRATE00000000000GAS",
      rateDate,
      product: "gasoline",
      benchmark: "US_RETAIL",
      pricePerUsg: 3.29,
      pricePerBbl: 138.18,
      pricePerMt: 1174.53,
      currency: "usd",
      source: "stub",
      createdAt,
    },
    {
      id: "01HSTUBRATE00000000000NG",
      rateDate,
      product: "natural_gas",
      benchmark: "HENRY_HUB",
      pricePerUsg: 0.063,
      pricePerBbl: 2.64,
      pricePerMt: 19.35,
      currency: "usd",
      source: "stub",
      createdAt,
    },
  ];
}
