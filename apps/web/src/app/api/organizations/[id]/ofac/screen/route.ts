import { NextResponse, type NextRequest } from "next/server";
import { buildUpstreamHeaders } from "@/lib/upstream-headers";

/**
 * POST /api/organizations/:id/ofac/screen — proxy to apps/api
 * `POST /organizations/:id/ofac/screen`. Enqueues a single-org
 * OFAC screen. Body forwarded as-is (currently empty; the api
 * derives the org id from the URL).
 */

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(
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
  const url = `${upstream.replace(/\/$/, "")}/organizations/${encodeURIComponent(params.id)}/ofac/screen`;
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: buildUpstreamHeaders(req),
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
