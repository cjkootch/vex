import { NextResponse, type NextRequest } from "next/server";
import { buildUpstreamHeaders } from "@/lib/upstream-headers";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * GET /api/agent-runs — proxy to apps/api `GET /agent-runs`. Consumed by
 * the AutonomyFeed rail and the /app/calls page, which poll every 5s for
 * run + approval status.
 *
 * Forwarded query params: `limit`, `status`, `since`, plus the legacy
 * `tenant_id=current` sentinel the feed sends (the upstream reads tenant
 * from the JWT, so the sentinel is dropped). When VEX_API_URL is unset
 * the route returns an empty stub so the UI renders cleanly in local dev.
 */
export async function GET(req: NextRequest): Promise<Response> {
  const upstream = process.env["VEX_API_URL"];
  const incoming = new URL(req.url);
  const forwarded = new URLSearchParams();
  for (const key of ["limit", "status", "since"] as const) {
    const value = incoming.searchParams.get(key);
    if (value) forwarded.set(key, value);
  }

  if (upstream) {
    const qs = forwarded.toString();
    const url = `${upstream.replace(/\/$/, "")}/agent-runs${qs ? `?${qs}` : ""}`;
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

  return NextResponse.json({ runs: [] });
}
