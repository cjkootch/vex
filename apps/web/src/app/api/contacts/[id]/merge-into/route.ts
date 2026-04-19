import { NextResponse, type NextRequest } from "next/server";
import { buildUpstreamHeaders } from "@/lib/upstream-headers";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(
  req: NextRequest,
  ctx: { params: { id: string } },
): Promise<Response> {
  const upstream = process.env["VEX_API_URL"];
  if (!upstream) {
    return NextResponse.json({ error: "upstream_unavailable" }, { status: 502 });
  }
  const url = `${upstream.replace(/\/$/, "")}/contacts/${encodeURIComponent(ctx.params.id)}/merge-into`;
  try {
    const headers = buildUpstreamHeaders(req);
    headers.set("content-type", "application/json");
    const response = await fetch(url, {
      method: "POST",
      headers,
      body: await req.text(),
    });
    const text = await response.text();
    return new Response(text, {
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
