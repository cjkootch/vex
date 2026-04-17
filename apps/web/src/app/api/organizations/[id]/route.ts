import { NextResponse, type NextRequest } from "next/server";
import { buildUpstreamHeaders } from "@/lib/upstream-headers";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * GET /api/organizations/:id — proxy to apps/api `GET /organizations/:id`.
 * Detail response includes the org's contact list (via the m:n
 * memberships table). Stubbed in local dev.
 */
export async function GET(
  req: NextRequest,
  { params }: { params: { id: string } },
): Promise<Response> {
  const upstream = process.env["VEX_API_URL"];

  if (upstream) {
    const url = `${upstream.replace(/\/$/, "")}/organizations/${encodeURIComponent(params.id)}`;
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

  return NextResponse.json({ organization: stubOrganization(params.id) });
}

function stubOrganization(id: string) {
  const now = new Date().toISOString();
  return {
    id,
    legalName: "Acme Corporation",
    domain: "acme.test",
    industry: "Manufacturing",
    fitScore: 0.91,
    status: "active",
    sourceOfTruth: "internal",
    externalKeys: { apollo: "apollo-acme-001" },
    contactCount: 2,
    createdAt: now,
    updatedAt: now,
    contacts: [
      {
        id: "01HSEEDCNT0000000000000001",
        fullName: "Contact 1",
        title: "VP Operations",
        email: "contact1@example1.test",
        phone: null,
        optedOut: false,
      },
      {
        id: "01HSEEDCNT0000000000000002",
        fullName: "Contact 2",
        title: "Procurement Lead",
        email: "contact2@example1.test",
        phone: null,
        optedOut: false,
      },
    ],
    deals: [
      {
        id: "01HSEEDDEA0000000000000001",
        dealRef: "VTC-2026-001",
        status: "negotiating",
        product: "ulsd",
        volumeUsg: 3_200_000,
        role: "buyer",
      },
    ],
  };
}
