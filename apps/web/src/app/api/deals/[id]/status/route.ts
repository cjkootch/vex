import { NextResponse, type NextRequest } from "next/server";
import { buildUpstreamHeaders } from "@/lib/upstream-headers";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * PATCH /api/deals/:id/status — proxy to apps/api
 * `PATCH /deals/:id/status`. Applies a status transition directly.
 * The upstream refuses to set `approved` / `cancelled` here —
 * callers should use /request for those.
 *
 * Local-dev stub just echoes back the target status so the UI has a
 * complete flow without a running API.
 */
export async function PATCH(
  req: NextRequest,
  { params }: { params: { id: string } },
): Promise<Response> {
  const upstream = process.env["VEX_API_URL"];
  const bodyText = await req.text();

  if (upstream) {
    const url = `${upstream.replace(/\/$/, "")}/deals/${encodeURIComponent(params.id)}/status`;
    try {
      const headers = buildUpstreamHeaders(req);
      headers.set("content-type", "application/json");
      const response = await fetch(url, {
        method: "PATCH",
        headers,
        body: bodyText,
      });
      const responseBody = await response.text();
      return new Response(responseBody, {
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

  let parsed: { status?: string } = {};
  try {
    parsed = JSON.parse(bodyText) as { status?: string };
  } catch {
    /* ignore */
  }
  if (!parsed.status) {
    return NextResponse.json(
      { error: "bad_request", message: "status required" },
      { status: 400 },
    );
  }
  if (parsed.status === "approved" || parsed.status === "cancelled") {
    return NextResponse.json(
      {
        error: "forbidden",
        message: `transition to '${parsed.status}' requires an approval — POST /deals/${params.id}/status/request`,
      },
      { status: 403 },
    );
  }
  return NextResponse.json({
    deal: { id: params.id, status: parsed.status, stub: true },
  });
}
