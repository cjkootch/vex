import { NextResponse, type NextRequest } from "next/server";
import { buildUpstreamHeaders } from "@/lib/upstream-headers";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(req: NextRequest): Promise<Response> {
  const upstream = process.env["VEX_API_URL"];
  const body = await req.text();
  if (upstream) {
    const url = `${upstream.replace(/\/$/, "")}/calls/demo-message`;
    try {
      const headers = buildUpstreamHeaders(req);
      headers.set("content-type", "application/json");
      const response = await fetch(url, { method: "POST", headers, body });
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
  return NextResponse.json(
    {
      messageSid: `SMSTUB${Math.random().toString(36).slice(2, 14).toUpperCase()}`,
      status: "queued",
      touchpointId: "01HSTUBDEMOMSG0000000000000",
    },
    { status: 202 },
  );
}
