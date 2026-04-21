import { NextResponse, type NextRequest } from "next/server";
import { buildUpstreamHeaders } from "@/lib/upstream-headers";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * Proxy for GET /deals/benchmarks?product=X&benchmark=Y. Returns the
 * latest fuel_market_rates row for the (product, benchmark) pair so the
 * deal creator can show a spread chip next to the sell price input.
 */
export async function GET(req: NextRequest): Promise<Response> {
  const upstream = process.env["VEX_API_URL"];
  if (!upstream) {
    // No upstream configured — render without benchmark context rather
    // than 503'ing the whole dashboard.
    return NextResponse.json({ rate: null });
  }
  const incoming = new URL(req.url);
  const forwarded = new URLSearchParams();
  for (const key of ["product", "benchmark"] as const) {
    const value = incoming.searchParams.get(key);
    if (value) forwarded.set(key, value);
  }
  const url = `${upstream.replace(/\/$/, "")}/deals/benchmarks?${forwarded.toString()}`;
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
