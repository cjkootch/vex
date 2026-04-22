import { NextResponse, type NextRequest } from "next/server";
import { buildUpstreamHeaders } from "@/lib/upstream-headers";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * POST /api/communications/touchpoints/:id/reply — operator-initiated
 * reply to an inbound email touchpoint. Thin proxy to the apps/api
 * endpoint that creates + auto-decides an email.send approval and
 * enqueues the executor.
 */
export async function POST(
  req: NextRequest,
  ctx: { params: { id: string } },
): Promise<Response> {
  const upstream = process.env["VEX_API_URL"];
  if (!upstream) {
    return NextResponse.json({ error: "upstream_unavailable" }, { status: 502 });
  }
  const url = `${upstream.replace(/\/$/, "")}/communications/touchpoints/${encodeURIComponent(ctx.params.id)}/reply`;
  try {
    const body = await req.text();
    const response = await fetch(url, {
      method: "POST",
      headers: {
        ...buildUpstreamHeaders(req),
        "content-type": "application/json",
      },
      body,
    });
    const respText = await response.text();
    return new Response(respText, {
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
