import { NextResponse, type NextRequest } from "next/server";
import { buildUpstreamHeaders } from "@/lib/upstream-headers";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * Proxy for /deals/:id/vessel.
 *   GET  → bundle of { deal, vessel, utilization, freightRate, marketRate, deviationPct }
 *          for the deal-overview VesselPanel.
 *   PATCH → link / relink vessel + record freight terms; the API stamps
 *          freight_rate_locked_at + snapshots today's market rate.
 */
export async function GET(
  req: NextRequest,
  { params }: { params: { id: string } },
): Promise<Response> {
  const upstream = process.env["VEX_API_URL"];
  if (!upstream) {
    // Empty state in local dev when API isn't running — matches the
    // shape the panel expects so it renders the empty state cleanly.
    return NextResponse.json({
      deal: { id: params.id, dealRef: "", volumeUsg: 0, volumeMt: null },
      vessel: null,
      utilization: { pctOfDwt: null, pctOnDeal: null },
      freightRate: {
        bookedUsdPerMt: null,
        lockedAt: null,
        source: null,
        marketAtLock: null,
        demurrageRateUsdPerDay: null,
        ballastBonusUsd: null,
        charterType: null,
      },
      marketRate: {
        currentUsdPerMt: null,
        asOfDate: null,
        source: null,
        lane: null,
      },
      deviationPct: null,
    });
  }
  const url = new URL(
    `/deals/${encodeURIComponent(params.id)}/vessel`,
    upstream,
  ).toString();
  return forward(url, req, "GET");
}

export async function PATCH(
  req: NextRequest,
  { params }: { params: { id: string } },
): Promise<Response> {
  const upstream = process.env["VEX_API_URL"];
  if (!upstream) {
    return NextResponse.json(
      { error: "not_configured", message: "VEX_API_URL is not set." },
      { status: 503 },
    );
  }
  const url = new URL(
    `/deals/${encodeURIComponent(params.id)}/vessel`,
    upstream,
  ).toString();
  return forward(url, req, "PATCH");
}

async function forward(
  url: string,
  req: NextRequest,
  method: "GET" | "PATCH",
): Promise<Response> {
  const headers = buildUpstreamHeaders(req);
  if (method === "PATCH") {
    const ct = req.headers.get("content-type");
    if (ct) headers.set("content-type", ct);
  }
  try {
    const response = await fetch(url, {
      method,
      headers,
      ...(method === "PATCH" ? { body: await req.text() } : {}),
    });
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
