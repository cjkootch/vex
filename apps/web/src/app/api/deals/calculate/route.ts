import { NextResponse, type NextRequest } from "next/server";
import { buildUpstreamHeaders } from "@/lib/upstream-headers";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * Proxy for POST /deals/calculate. The deal-creator dashboard posts a
 * partial inputs bundle and gets back { results, missingEconomicsFields }.
 * No persistence — the endpoint just runs the pure calculator upstream.
 */
export async function POST(req: NextRequest): Promise<Response> {
  const upstream = process.env["VEX_API_URL"];
  if (!upstream) {
    return NextResponse.json(
      { error: "deals_not_configured", message: "VEX_API_URL is not set." },
      { status: 503 },
    );
  }
  const url = new URL("/deals/calculate", upstream).toString();
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: buildUpstreamHeaders(req),
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
