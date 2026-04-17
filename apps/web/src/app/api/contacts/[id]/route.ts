import { NextResponse, type NextRequest } from "next/server";
import { buildUpstreamHeaders } from "@/lib/upstream-headers";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * GET /api/contacts/:id — proxy to apps/api `GET /contacts/:id`.
 * Returns the contact + its full memberships list (m:n). Stubbed in
 * local dev against the seeded Contact 1 which belongs to two orgs.
 */
export async function GET(
  req: NextRequest,
  { params }: { params: { id: string } },
): Promise<Response> {
  const upstream = process.env["VEX_API_URL"];

  if (upstream) {
    const url = `${upstream.replace(/\/$/, "")}/contacts/${encodeURIComponent(params.id)}`;
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

  const now = new Date().toISOString();
  return NextResponse.json({
    contact: {
      id: params.id,
      tenantId: "01HSEEDWRK0000000000000001",
      orgId: "01HSEEDCRP0000000000000001",
      fullName: "Contact 1",
      title: "VP Operations",
      emails: ["contact1@example1.test"],
      phones: [],
      roleScore: null,
      externalKeys: {},
      fieldConfidence: {},
      status: "active",
      timezone: null,
      optOutAt: null,
      optOutReason: null,
      createdAt: now,
      updatedAt: now,
    },
    memberships: [
      {
        tenantId: "01HSEEDWRK0000000000000001",
        contactId: params.id,
        orgId: "01HSEEDCRP0000000000000001",
        role: "VP Operations",
        isPrimary: true,
        since: now,
        until: null,
        createdAt: now,
        updatedAt: now,
      },
      {
        tenantId: "01HSEEDWRK0000000000000001",
        contactId: params.id,
        orgId: "01HSEEDCRP0000000000000002",
        role: "Advisor",
        isPrimary: false,
        since: now,
        until: null,
        createdAt: now,
        updatedAt: now,
      },
    ],
  });
}
