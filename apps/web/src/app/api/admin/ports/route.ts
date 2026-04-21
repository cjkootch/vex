import { NextResponse, type NextRequest } from "next/server";
import { buildUpstreamHeaders } from "@/lib/upstream-headers";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** Proxy for /admin/ports (GET list + POST create). */

export async function GET(req: NextRequest): Promise<Response> {
  const upstream = process.env["VEX_API_URL"];
  if (!upstream) return NextResponse.json({ ports: [] });
  return forward(`${upstream.replace(/\/$/, "")}/admin/ports`, req, "GET");
}

export async function POST(req: NextRequest): Promise<Response> {
  const upstream = process.env["VEX_API_URL"];
  if (!upstream) {
    return NextResponse.json(
      { error: "not_configured", message: "VEX_API_URL is not set." },
      { status: 503 },
    );
  }
  return forward(`${upstream.replace(/\/$/, "")}/admin/ports`, req, "POST");
}

async function forward(
  url: string,
  req: NextRequest,
  method: "GET" | "POST",
): Promise<Response> {
  const headers = buildUpstreamHeaders(req);
  if (method === "POST") {
    const ct = req.headers.get("content-type");
    if (ct) headers.set("content-type", ct);
  }
  try {
    const response = await fetch(url, {
      method,
      headers,
      ...(method === "POST" ? { body: await req.text() } : {}),
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
