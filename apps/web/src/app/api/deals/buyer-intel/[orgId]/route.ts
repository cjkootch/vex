import { NextResponse, type NextRequest } from "next/server";
import { buildUpstreamHeaders } from "@/lib/upstream-headers";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * Proxy for GET /deals/buyer-intel/:orgId. Returns the buyer's latest
 * counterparty-risk row plus their concentration share of the open
 * pipeline. Called by the deal creator whenever the buyer dropdown
 * changes so the right pane can render a "know-your-counterparty"
 * callout before the deal is saved.
 */
export async function GET(
  req: NextRequest,
  { params }: { params: { orgId: string } },
): Promise<Response> {
  const upstream = process.env["VEX_API_URL"];
  if (!upstream) {
    return NextResponse.json({
      counterparty: null,
      concentration: {
        buyerShare: 0,
        buyerVolumeUsg: 0,
        totalOpenVolumeUsg: 0,
        openDealCount: 0,
      },
    });
  }
  const url = new URL(
    `/deals/buyer-intel/${encodeURIComponent(params.orgId)}`,
    upstream,
  ).toString();
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
