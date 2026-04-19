import { NextResponse, type NextRequest } from "next/server";
import { buildUpstreamHeaders } from "@/lib/upstream-headers";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * GET /api/admin/feature-requests — proxies to apps/api
 * `GET /admin/feature-requests`. OWNER-only; the upstream enforces.
 */
export async function GET(req: NextRequest): Promise<Response> {
  const upstream = process.env["VEX_API_URL"];
  if (!upstream) {
    return NextResponse.json({ items: [], nextBefore: null });
  }
  const qs = req.nextUrl.searchParams.toString();
  const url = `${upstream.replace(/\/$/, "")}/admin/feature-requests${qs ? `?${qs}` : ""}`;
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
