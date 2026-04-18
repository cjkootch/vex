import { NextResponse, type NextRequest } from "next/server";
import { buildUpstreamHeaders } from "@/lib/upstream-headers";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * GET /api/deals/:id — proxy to apps/api `GET /deals/:id`. Stubbed
 * in local dev against the seeded VTC-2026-001 payload so the detail
 * page renders without a running API.
 */
export async function GET(
  req: NextRequest,
  { params }: { params: { id: string } },
): Promise<Response> {
  const upstream = process.env["VEX_API_URL"];

  if (upstream) {
    const url = `${upstream.replace(/\/$/, "")}/deals/${encodeURIComponent(params.id)}`;
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

  return NextResponse.json({ deal: stubDeal(params.id) });
}

/**
 * PATCH /api/deals/:id — proxy to apps/api `PATCH /deals/:id`. Applies
 * partial edits (product / volume / pricing / terms / ports / laycan
 * / notes / buyer). Status changes and dealRef edits are handled
 * elsewhere.
 */
export async function PATCH(
  req: NextRequest,
  { params }: { params: { id: string } },
): Promise<Response> {
  const upstream = process.env["VEX_API_URL"];
  const bodyText = await req.text();

  if (upstream) {
    const url = `${upstream.replace(/\/$/, "")}/deals/${encodeURIComponent(params.id)}`;
    try {
      const headers = buildUpstreamHeaders(req);
      headers.set("content-type", "application/json");
      const response = await fetch(url, {
        method: "PATCH",
        headers,
        body: bodyText,
      });
      const responseBody = await response.text();
      return new Response(responseBody, {
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

  return NextResponse.json(
    {
      error: "not_implemented",
      message: "PATCH /api/deals/:id not implemented in local stub",
    },
    { status: 501 },
  );
}

function stubDeal(id: string) {
  const now = new Date().toISOString();
  return {
    id,
    dealRef: "VTC-2026-001",
    status: "negotiating",
    product: "ulsd",
    buyerOrgId: "01HSEEDCRP0000000000000006",
    buyerName: "Massy Jamaica",
    volumeUsg: 3_200_000,
    incoterm: "cfr",
    laycanStart: "2026-05-12",
    laycanEnd: "2026-05-20",
    complianceHold: true,
    ofacStatus: "in_progress",
    createdAt: now,
    updatedAt: now,
    sellerOrgId: null,
    sellerName: null,
    originPort: "Houston",
    destinationPort: "Kingston",
    paymentTerms: "lc_sight",
    currency: "usd",
    notes: "Buyer requested CFR; vessel nomination pending OFAC clearance.",
    latestScenario: {
      id: "01HSEEDSCN0000000000000001",
      scenarioName: "base",
      scenarioType: "base",
      isActive: true,
      score: 55,
      recommendation: "marginal",
      resultsJson: null,
    },
  };
}
