import { NextResponse, type NextRequest } from "next/server";
import { buildUpstreamHeaders } from "@/lib/upstream-headers";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * Proxy for POST /voice/transcribe. The chat composer's mic button
 * POSTs a multipart/form-data blob here; we forward the raw body and
 * content-type upstream so Fastify-multipart on the API side sees the
 * exact same stream. Only the NextAuth cookie is lifted to a Bearer
 * header — no key material or body mutation happens here.
 */
export async function POST(req: NextRequest): Promise<Response> {
  const upstream = process.env["VEX_API_URL"];
  if (!upstream) {
    return NextResponse.json(
      { error: "voice_not_configured", message: "VEX_API_URL is not set." },
      { status: 503 },
    );
  }
  const url = new URL("/voice/transcribe", upstream).toString();
  const headers = buildUpstreamHeaders(req);
  const contentType = req.headers.get("content-type");
  if (contentType) headers.set("content-type", contentType);
  try {
    const body = Buffer.from(await req.arrayBuffer());
    const response = await fetch(url, {
      method: "POST",
      headers,
      body,
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
