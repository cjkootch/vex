import { NextResponse, type NextRequest } from "next/server";
import { buildUpstreamHeaders } from "@/lib/upstream-headers";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * GET /api/contacts — proxy to apps/api `GET /contacts` with
 * `status=active|suppressed` + `limit`. Local-dev stub returns the
 * seeded contacts so /app/contacts renders without a running API.
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
    const url = `${upstream.replace(/\/$/, "")}/contacts${qs ? `?${qs}` : ""}`;
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

  const status = incoming.searchParams.get("status");
  return NextResponse.json({
    contacts: status === "suppressed" ? stubSuppressed() : stubActive(),
  });
}

interface StubOrgLink {
  orgId: string;
  role: string | null;
  isPrimary: boolean;
}

function baseContact(
  id: string,
  primaryOrgId: string,
  fullName: string,
  title: string,
  email: string,
  orgs: StubOrgLink[] = [{ orgId: primaryOrgId, role: title, isPrimary: true }],
  optOutAt: string | null = null,
) {
  const now = new Date().toISOString();
  return {
    id,
    tenantId: "01HSEEDWRK0000000000000001",
    orgId: primaryOrgId,
    fullName,
    title,
    emails: [email],
    phones: [],
    roleScore: null,
    externalKeys: {},
    fieldConfidence: {},
    status: optOutAt ? "inactive" : "active",
    timezone: null,
    optOutAt,
    optOutReason: optOutAt ? "user requested" : null,
    createdAt: now,
    updatedAt: now,
    orgs,
  };
}

function stubActive() {
  return [
    baseContact(
      "01HSEEDCNT0000000000000001",
      "01HSEEDCRP0000000000000001",
      "Contact 1",
      "VP Operations",
      "contact1@example1.test",
      [
        { orgId: "01HSEEDCRP0000000000000001", role: "VP Operations", isPrimary: true },
        { orgId: "01HSEEDCRP0000000000000002", role: "Advisor", isPrimary: false },
      ],
    ),
    baseContact(
      "01HSEEDCNT0000000000000002",
      "01HSEEDCRP0000000000000001",
      "Contact 2",
      "Procurement Lead",
      "contact2@example1.test",
      [
        { orgId: "01HSEEDCRP0000000000000001", role: "Procurement Lead", isPrimary: true },
        { orgId: "01HSEEDCRP0000000000000003", role: "Board Observer", isPrimary: false },
      ],
    ),
    baseContact(
      "01HSEEDCNT0000000000000003",
      "01HSEEDCRP0000000000000002",
      "Globex Lead",
      "Head of Energy",
      "lead@globex.test",
    ),
    baseContact(
      "01HSEEDCNT0000000000000004",
      "01HSEEDCRP0000000000000006",
      "Massy Trader",
      "Director of Fuel Trading",
      "trader@massyjm.test",
    ),
  ];
}

function stubSuppressed() {
  return [
    baseContact(
      "01HSEEDCNT0000000000000099",
      "01HSEEDCRP0000000000000003",
      "Former Contact",
      "IT Director",
      "former@initech.test",
      [
        {
          orgId: "01HSEEDCRP0000000000000003",
          role: "IT Director",
          isPrimary: true,
        },
      ],
      new Date(Date.now() - 7 * 24 * 3600 * 1000).toISOString(),
    ),
  ];
}
