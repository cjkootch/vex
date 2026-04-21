import { NextResponse, type NextRequest } from "next/server";
import { buildUpstreamHeaders } from "@/lib/upstream-headers";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * Proxy for GET /deals/:id/vessel/freight-history?days=N — returns
 * `{ lane, points: [{ date, rateUsdPerMt, source }] }` for the
 * VesselPanel's freight-history sparkline.
 */
export async function GET(
  req: NextRequest,
  { params }: { params: { id: string } },
): Promise<Response> {
  const upstream = process.env["VEX_API_URL"];
  if (!upstream) {
    return NextResponse.json({ lane: null, points: [] });
  }
  const incoming = new URL(req.url);
  const days = incoming.searchParams.get("days");
  const url =
    `${upstream.replace(/\/$/, "")}/deals/${encodeURIComponent(params.id)}/vessel/freight-history` +
    (days ? `?days=${encodeURIComponent(days)}` : "");
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
