import { NextResponse, type NextRequest } from "next/server";
import { buildUpstreamHeaders } from "@/lib/upstream-headers";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * GET /api/market/alerts — proxy to apps/api `GET /market/alerts`.
 * Forwards `since` and `limit`. Local-dev stub returns two crossings so
 * the panel has something to render without a worker pipeline.
 */
export async function GET(req: NextRequest): Promise<Response> {
  const upstream = process.env["VEX_API_URL"];
  const incoming = new URL(req.url);

  if (upstream) {
    const forwarded = new URLSearchParams();
    for (const key of ["since", "limit"] as const) {
      const value = incoming.searchParams.get(key);
      if (value) forwarded.set(key, value);
    }
    const qs = forwarded.toString();
    const url = `${upstream.replace(/\/$/, "")}/market/alerts${qs ? `?${qs}` : ""}`;
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

  return NextResponse.json({ alerts: stubAlerts() });
}

function stubAlerts() {
  const now = new Date();
  const occurredAt = (minsAgo: number): string =>
    new Date(now.getTime() - minsAgo * 60 * 1000).toISOString();
  return [
    {
      id: "01HSTUBALRT000000000001",
      product: "diesel",
      benchmark: "NY_HARBOR_ULSD",
      direction: "up" as const,
      changePct: 6.8,
      currentPriceUsg: 2.61,
      baselinePriceUsg: 2.44,
      baselineDays: 30,
      thresholdPct: 5,
      occurredAt: occurredAt(45),
    },
    {
      id: "01HSTUBALRT000000000002",
      product: "crude",
      benchmark: "WTI",
      direction: "down" as const,
      changePct: -5.4,
      currentPriceUsg: 1.83,
      baselinePriceUsg: 1.93,
      baselineDays: 30,
      thresholdPct: 5,
      occurredAt: occurredAt(180),
    },
  ];
}
