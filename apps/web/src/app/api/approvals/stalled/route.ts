import { NextResponse, type NextRequest } from "next/server";
import { buildUpstreamHeaders } from "@/lib/upstream-headers";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * GET /api/approvals/stalled — proxy to apps/api
 * `GET /approvals/stalled`. Drives the stalled-approval banner in
 * the /app layout. Accepts `after_sec` query param (default 60).
 */
export async function GET(req: NextRequest): Promise<Response> {
  const upstream = process.env["VEX_API_URL"];
  if (!upstream) {
    return NextResponse.json({ approvals: [] });
  }
  const search = req.nextUrl.searchParams.toString();
  const url = `${upstream.replace(/\/$/, "")}/approvals/stalled${search ? `?${search}` : ""}`;
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
