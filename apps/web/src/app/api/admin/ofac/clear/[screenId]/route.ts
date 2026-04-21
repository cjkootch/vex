import { NextResponse, type NextRequest } from "next/server";
import { buildUpstreamHeaders } from "@/lib/upstream-headers";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * Proxy for PATCH /admin/ofac/clear/:screenId — operator clears a
 * potential match with a mandatory reason.
 */
export async function PATCH(
  req: NextRequest,
  { params }: { params: { screenId: string } },
): Promise<Response> {
  const upstream = process.env["VEX_API_URL"];
  if (!upstream) {
    return NextResponse.json(
      { error: "not_configured", message: "VEX_API_URL is not set." },
      { status: 503 },
    );
  }
  const url = new URL(
    `/admin/ofac/clear/${encodeURIComponent(params.screenId)}`,
    upstream,
  ).toString();
  try {
    const headers = buildUpstreamHeaders(req);
    const ct = req.headers.get("content-type");
    if (ct) headers.set("content-type", ct);
    const response = await fetch(url, {
      method: "PATCH",
      headers,
      body: await req.text(),
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
