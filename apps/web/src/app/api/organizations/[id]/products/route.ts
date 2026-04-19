import { NextResponse, type NextRequest } from "next/server";
import { buildUpstreamHeaders } from "@/lib/upstream-headers";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(
  req: NextRequest,
  ctx: { params: { id: string } },
): Promise<Response> {
  const upstream = process.env["VEX_API_URL"];
  if (!upstream) return NextResponse.json({ products: [] });
  const url = `${upstream.replace(/\/$/, "")}/organizations/${encodeURIComponent(ctx.params.id)}/products`;
  return proxy(url, req, "GET");
}

export async function POST(
  req: NextRequest,
  ctx: { params: { id: string } },
): Promise<Response> {
  const upstream = process.env["VEX_API_URL"];
  if (!upstream) {
    return NextResponse.json({ error: "upstream_unavailable" }, { status: 502 });
  }
  const url = `${upstream.replace(/\/$/, "")}/organizations/${encodeURIComponent(ctx.params.id)}/products`;
  return proxy(url, req, "POST");
}

async function proxy(
  url: string,
  req: NextRequest,
  method: "GET" | "POST",
): Promise<Response> {
  try {
    const headers = buildUpstreamHeaders(req);
    if (method === "POST") headers.set("content-type", "application/json");
    const init: RequestInit = { method, headers };
    if (method === "POST") init.body = await req.text();
    const response = await fetch(url, init);
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
