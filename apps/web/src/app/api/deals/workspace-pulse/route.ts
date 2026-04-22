import { NextResponse, type NextRequest } from "next/server";
import { buildUpstreamHeaders } from "@/lib/upstream-headers";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * GET /api/deals/workspace-pulse — proxy to apps/api
 * `GET /deals/workspace-pulse`. Per-deal execution status across all
 * open deals, grouped by urgency. Drives the brief "Deals needing
 * attention" section and the grouped view on /app/deals.
 */
export async function GET(req: NextRequest): Promise<Response> {
  const upstream = process.env["VEX_API_URL"];
  if (!upstream) {
    return NextResponse.json({
      generatedAt: new Date().toISOString(),
      deals: [],
      summary: { blocked: 0, at_risk: 0, stale: 0, healthy: 0 },
    });
  }
  const url = `${upstream.replace(/\/$/, "")}/deals/workspace-pulse`;
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
