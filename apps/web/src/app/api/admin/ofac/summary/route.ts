import { NextResponse, type NextRequest } from "next/server";
import { buildUpstreamHeaders } from "@/lib/upstream-headers";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** Proxy for GET /admin/ofac/summary — status-bar numbers. */
export async function GET(req: NextRequest): Promise<Response> {
  const upstream = process.env["VEX_API_URL"];
  if (!upstream) {
    return NextResponse.json({
      counts: {
        unscreened: 0,
        clear: 0,
        potential_match: 0,
        confirmed_match: 0,
        cleared_by_operator: 0,
      },
      lastScreenAt: null,
      totalOrgs: 0,
    });
  }
  const url = `${upstream.replace(/\/$/, "")}/admin/ofac/summary`;
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
