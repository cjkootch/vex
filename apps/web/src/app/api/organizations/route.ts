import { NextResponse, type NextRequest } from "next/server";
import { buildUpstreamHeaders } from "@/lib/upstream-headers";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * GET /api/organizations — proxy to apps/api `GET /organizations`.
 * Forwards `status` and `limit`. Local-dev stub returns the seeded
 * companies so /app/companies renders without a running API.
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
    const url = `${upstream.replace(/\/$/, "")}/organizations${qs ? `?${qs}` : ""}`;
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

  return NextResponse.json({ organizations: stubOrganizations() });
}

function stubOrganizations() {
  const now = new Date().toISOString();
  return [
    {
      id: "01HSEEDCRP0000000000000001",
      legalName: "Acme Corporation",
      domain: "acme.test",
      industry: "Manufacturing",
      fitScore: 0.91,
      status: "active",
      contactCount: 4,
      createdAt: now,
      updatedAt: now,
    },
    {
      id: "01HSEEDCRP0000000000000002",
      legalName: "Globex Industries",
      domain: "globex.test",
      industry: "Energy",
      fitScore: 0.74,
      status: "active",
      contactCount: 2,
      createdAt: now,
      updatedAt: now,
    },
    {
      id: "01HSEEDCRP0000000000000003",
      legalName: "Initech",
      domain: "initech.test",
      industry: "Software",
      fitScore: 0.63,
      status: "active",
      contactCount: 3,
      createdAt: now,
      updatedAt: now,
    },
    {
      id: "01HSEEDCRP0000000000000006",
      legalName: "Massy Jamaica",
      domain: "massyjm.test",
      industry: "Energy Trading",
      fitScore: 0.88,
      status: "active",
      contactCount: 2,
      createdAt: now,
      updatedAt: now,
    },
    {
      id: "01HSEEDCRP0000000000000007",
      legalName: "Punta Caucedo Power",
      domain: "ptcaucedo.test",
      industry: "Power Generation",
      fitScore: 0.82,
      status: "active",
      contactCount: 1,
      createdAt: now,
      updatedAt: now,
    },
    {
      id: "01HSEEDCRP0000000000000008",
      legalName: "Caribbean Airlines",
      domain: "caribbean-airlines.test",
      industry: "Aviation",
      fitScore: 0.79,
      status: "active",
      contactCount: 2,
      createdAt: now,
      updatedAt: now,
    },
  ];
}
