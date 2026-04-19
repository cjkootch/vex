import { NextResponse, type NextRequest } from "next/server";
import { buildUpstreamHeaders } from "@/lib/upstream-headers";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(
  req: NextRequest,
  { params }: { params: { id: string } },
): Promise<Response> {
  const upstream = process.env["VEX_API_URL"];
  if (upstream) {
    const url = `${upstream.replace(/\/$/, "")}/follow-ups/${encodeURIComponent(params.id)}/complete`;
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: buildUpstreamHeaders(req),
      });
      const body = await res.text();
      return new Response(body, {
        status: res.status,
        headers: {
          "content-type":
            res.headers.get("content-type") ?? "application/json",
        },
      });
    } catch (err) {
      return NextResponse.json(
        { error: "upstream_unavailable", message: (err as Error).message },
        { status: 502 },
      );
    }
  }
  return NextResponse.json({ id: params.id, status: "completed" });
}
