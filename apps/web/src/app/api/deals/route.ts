import { NextResponse, type NextRequest } from "next/server";
import { buildUpstreamHeaders } from "@/lib/upstream-headers";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * GET /api/deals — proxy to apps/api `GET /deals`. Forwards `status`
 * and `limit` query params. When `VEX_API_URL` is unset, returns a
 * three-row stub that matches the seeded fuel deals so the list page
 * renders in local dev without a running API.
 */
export async function GET(req: NextRequest): Promise<Response> {
  const upstream = process.env["VEX_API_URL"];
  const incoming = new URL(req.url);

  if (upstream) {
    const forwarded = new URLSearchParams();
    for (const key of ["status", "limit"] as const) {
      const value = incoming.searchParams.get(key);
      if (value) forwarded.set(key, value);
    }
    const qs = forwarded.toString();
    const url = `${upstream.replace(/\/$/, "")}/deals${qs ? `?${qs}` : ""}`;
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

  return NextResponse.json({ deals: stubDeals() });
}

function stubDeals() {
  const now = new Date().toISOString();
  return [
    {
      id: "01HSEEDDEA0000000000000001",
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
    },
    {
      id: "01HSEEDDEA0000000000000002",
      dealRef: "VTC-2026-002",
      status: "approved",
      product: "ulsd",
      buyerOrgId: "01HSEEDCRP0000000000000007",
      buyerName: "Punta Caucedo Power",
      volumeUsg: 4_800_000,
      incoterm: "fob",
      laycanStart: "2026-05-05",
      laycanEnd: "2026-05-10",
      complianceHold: false,
      ofacStatus: "cleared",
      createdAt: now,
      updatedAt: now,
    },
    {
      id: "01HSEEDDEA0000000000000003",
      dealRef: "VTC-2026-003",
      status: "draft",
      product: "jet_a1",
      buyerOrgId: "01HSEEDCRP0000000000000008",
      buyerName: "Caribbean Airlines",
      volumeUsg: 1_500_000,
      incoterm: "cfr",
      laycanStart: "2026-06-02",
      laycanEnd: "2026-06-08",
      complianceHold: true,
      ofacStatus: "not_started",
      createdAt: now,
      updatedAt: now,
    },
  ];
}
