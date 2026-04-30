import { NextResponse, type NextRequest } from "next/server";
import { buildUpstreamHeaders } from "@/lib/upstream-headers";

/**
 * GET /api/organizations/:id/ofac/export — proxy to apps/api
 * `GET /organizations/:id/ofac/export`. Streams the JSON download
 * (Content-Disposition: attachment) verbatim back to the browser
 * so the file save dialog fires.
 */

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(
  req: NextRequest,
  { params }: { params: { id: string } },
): Promise<Response> {
  const upstream = process.env["VEX_API_URL"];
  if (!upstream) {
    return NextResponse.json(
      { error: "upstream_unavailable" },
      { status: 502 },
    );
  }
  const url = `${upstream.replace(/\/$/, "")}/organizations/${encodeURIComponent(params.id)}/ofac/export`;
  try {
    const response = await fetch(url, { headers: buildUpstreamHeaders(req) });
    const body = await response.text();
    // Preserve Content-Disposition so the browser saves rather than
    // renders inline; fall back to a sensible default if upstream
    // didn't set one (e.g. on 404).
    const headers: Record<string, string> = {
      "content-type":
        response.headers.get("content-type") ?? "application/json",
    };
    const disposition = response.headers.get("content-disposition");
    if (disposition) headers["content-disposition"] = disposition;
    return new Response(body, {
      status: response.status,
      headers,
    });
  } catch (err) {
    return NextResponse.json(
      { error: "upstream_unavailable", message: (err as Error).message },
      { status: 502 },
    );
  }
}
