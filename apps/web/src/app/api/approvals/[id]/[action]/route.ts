import { NextResponse, type NextRequest } from "next/server";
import { buildUpstreamHeaders } from "@/lib/upstream-headers";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * Sprint-6 stub for approve/reject. Proxies to apps/api when VEX_API_URL is
 * set; otherwise echoes back a successful decision so the UI flow can be
 * exercised locally.
 */
export async function POST(
  req: NextRequest,
  { params }: { params: { id: string; action: string } },
): Promise<Response> {
  if (params.action !== "approve" && params.action !== "reject") {
    return NextResponse.json({ error: "unknown_action" }, { status: 400 });
  }
  const upstream = process.env["VEX_API_URL"];
  if (upstream) {
    const url = `${upstream.replace(/\/$/, "")}/approvals/${encodeURIComponent(params.id)}/${params.action}`;
    try {
      const upstreamHeaders = buildUpstreamHeaders(req);
      upstreamHeaders.set("content-type", "application/json");
      const response = await fetch(url, {
        method: "POST",
        headers: upstreamHeaders,
        body: await req.text(),
      });
      const body = await response.text();
      return new Response(body, {
        status: response.status,
        headers: { "content-type": response.headers.get("content-type") ?? "application/json" },
      });
    } catch (err) {
      return NextResponse.json(
        { error: "upstream_unavailable", message: (err as Error).message },
        { status: 502 },
      );
    }
  }

  return NextResponse.json({
    approval: {
      id: params.id,
      decision: params.action === "approve" ? "approved" : "rejected",
      decidedAt: new Date().toISOString(),
    },
  });
}
