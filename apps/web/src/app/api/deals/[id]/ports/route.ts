import { NextResponse, type NextRequest } from "next/server";
import { buildUpstreamHeaders } from "@/lib/upstream-headers";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * Proxy for /deals/:id/ports.
 *   GET   → { deal, originPort, destinationPort, originEvents,
 *            destinationEvents, warnings, resolution } for the
 *            deal-overview PortPanel.
 *   PATCH → link / unlink a port on either leg. Pass null to
 *            unlink; undefined to leave unchanged.
 */

export async function GET(
  req: NextRequest,
  { params }: { params: { id: string } },
): Promise<Response> {
  const upstream = process.env["VEX_API_URL"];
  if (!upstream) {
    return NextResponse.json({
      deal: { id: params.id, dealRef: "", product: "" },
      originPort: null,
      destinationPort: null,
      originEvents: [],
      destinationEvents: [],
      warnings: [],
      resolution: { origin: null, destination: null },
    });
  }
  const url = new URL(
    `/deals/${encodeURIComponent(params.id)}/ports`,
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
    `/deals/${encodeURIComponent(params.id)}/ports`,
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
