import { NextResponse, type NextRequest } from "next/server";
import { buildUpstreamHeaders } from "@/lib/upstream-headers";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** Proxy for POST /admin/ofac/run — enqueues a batch screen. */
export async function POST(req: NextRequest): Promise<Response> {
  const upstream = process.env["VEX_API_URL"];
  if (!upstream) {
    return NextResponse.json(
      { error: "not_configured", message: "VEX_API_URL is not set." },
      { status: 503 },
    );
  }
  const url = `${upstream.replace(/\/$/, "")}/admin/ofac/run`;
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
