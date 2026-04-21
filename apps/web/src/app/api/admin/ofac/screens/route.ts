import { NextResponse, type NextRequest } from "next/server";
import { buildUpstreamHeaders } from "@/lib/upstream-headers";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** Proxy for GET /admin/ofac/screens?status=... */
export async function GET(req: NextRequest): Promise<Response> {
  const upstream = process.env["VEX_API_URL"];
  if (!upstream) return NextResponse.json({ screens: [] });
  const incoming = new URL(req.url);
  const forwarded = new URLSearchParams();
  const status = incoming.searchParams.get("status");
  if (status) forwarded.set("status", status);
  const url = `${upstream.replace(/\/$/, "")}/admin/ofac/screens${
    forwarded.toString() ? `?${forwarded.toString()}` : ""
  }`;
  try {
    const response = await fetch(url, { headers: buildUpstreamHeaders(req) });
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
