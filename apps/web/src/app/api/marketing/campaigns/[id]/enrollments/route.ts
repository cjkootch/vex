import { NextResponse, type NextRequest } from "next/server";
import { buildUpstreamHeaders } from "@/lib/upstream-headers";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * GET /api/marketing/campaigns/:id/enrollments — list enrollments
 * for the campaign. Forwards `state` + `limit` query params.
 */
export async function GET(
  req: NextRequest,
  { params }: { params: { id: string } },
): Promise<Response> {
  const upstream = process.env["VEX_API_URL"];
  const incoming = new URL(req.url);

  if (upstream) {
    const forwarded = new URLSearchParams();
    for (const key of ["state", "limit"] as const) {
      const value = incoming.searchParams.get(key);
      if (value) forwarded.set(key, value);
    }
    const qs = forwarded.toString();
    const url = `${upstream.replace(/\/$/, "")}/marketing/campaigns/${encodeURIComponent(params.id)}/enrollments${qs ? `?${qs}` : ""}`;
    try {
      const res = await fetch(url, { headers: buildUpstreamHeaders(req) });
      const text = await res.text();
      return new Response(text, {
        status: res.status,
        headers: {
          "content-type": res.headers.get("content-type") ?? "application/json",
        },
      });
    } catch (err) {
      return NextResponse.json(
        { error: "upstream_unavailable", message: (err as Error).message },
        { status: 502 },
      );
    }
  }
  return NextResponse.json({
    enrollments: [],
    counts: { enrolled: 0, completed: 0, paused: 0, unsubscribed: 0, errored: 0 },
  });
}
