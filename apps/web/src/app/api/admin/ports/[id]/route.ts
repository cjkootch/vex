import { NextResponse, type NextRequest } from "next/server";
import { buildUpstreamHeaders } from "@/lib/upstream-headers";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** Proxy for /admin/ports/:id (GET + PATCH). */

export async function GET(
  req: NextRequest,
  { params }: { params: { id: string } },
): Promise<Response> {
  const upstream = process.env["VEX_API_URL"];
  if (!upstream) {
    return NextResponse.json(
      { error: "not_configured", message: "VEX_API_URL is not set." },
      { status: 503 },
    );
  }
  const url = new URL(
    `/admin/ports/${encodeURIComponent(params.id)}`,
    upstream,
  ).toString();
  return forward(url, req, "GET");
}

export async function PATCH(
  req: NextRequest,
  { params }: { params: { id: string } },
): Promise<Response> {
  const upstream = process.env["VEX_API_URL"];
  if (!upstream) {
    return NextResponse.json(
      { error: "not_configured", message: "VEX_API_URL is not set." },
      { status: 503 },
    );
  }
  const url = new URL(
    `/admin/ports/${encodeURIComponent(params.id)}`,
    upstream,
  ).toString();
  return forward(url, req, "PATCH");
}

async function forward(
  url: string,
  req: NextRequest,
  method: "GET" | "PATCH",
): Promise<Response> {
  const headers = buildUpstreamHeaders(req);
  if (method === "PATCH") {
    const ct = req.headers.get("content-type");
    if (ct) headers.set("content-type", ct);
  }
  try {
    const response = await fetch(url, {
      method,
      headers,
      ...(method === "PATCH" ? { body: await req.text() } : {}),
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
