import { NextResponse, type NextRequest } from "next/server";
import { buildUpstreamHeaders } from "@/lib/upstream-headers";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * GET /api/marketing/campaigns — proxy to apps/api
 * `GET /marketing/campaigns`. Forwards `status` and `limit` query
 * params. When `VEX_API_URL` is unset, returns a three-row stub that
 * matches the seeded campaigns so the list page renders in local dev
 * without a running API.
 *
 * POST /api/marketing/campaigns — proxy to apps/api
 * `POST /marketing/campaigns`. Forwards the JSON body. Local-dev stub
 * echoes a created campaign with zeroed rollups so the "New campaign"
 * form can round-trip without a running API.
 */
export async function POST(req: NextRequest): Promise<Response> {
  const upstream = process.env["VEX_API_URL"];
  if (upstream) {
    const url = `${upstream.replace(/\/$/, "")}/marketing/campaigns`;
    try {
      const body = await req.text();
      const headers = buildUpstreamHeaders(req);
      headers.set("content-type", "application/json");
      const response = await fetch(url, { method: "POST", headers, body });
      const respBody = await response.text();
      return new Response(respBody, {
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

  let payload: Record<string, unknown>;
  try {
    payload = (await req.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json(
      { error: "invalid_json", message: "POST body is not valid JSON" },
      { status: 400 },
    );
  }
  if (typeof payload["channel"] !== "string" || payload["channel"].length === 0) {
    return NextResponse.json(
      { error: "validation", message: "channel is required" },
      { status: 400 },
    );
  }
  const now = new Date().toISOString();
  const randId = Math.random().toString(36).slice(2, 14).toUpperCase().padEnd(14, "0");
  return NextResponse.json(
    {
      campaign: {
        id: `01HSTUBCPN${randId}`,
        channel: payload["channel"],
        source: (payload["source"] as string | undefined) ?? null,
        medium: (payload["medium"] as string | undefined) ?? null,
        accountRef: (payload["accountRef"] as string | undefined) ?? null,
        spend: (payload["spend"] as number | undefined) ?? null,
        objective: (payload["objective"] as string | undefined) ?? null,
        status: (payload["status"] as string | undefined) ?? "active",
        touchpointCount: 0,
        sent: 0,
        delivered: 0,
        opened: 0,
        clicked: 0,
        bounced: 0,
        createdAt: now,
        updatedAt: now,
      },
    },
    { status: 201 },
  );
}

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
    const url = `${upstream.replace(/\/$/, "")}/marketing/campaigns${qs ? `?${qs}` : ""}`;
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

  return NextResponse.json({ campaigns: stubCampaigns() });
}

function stubCampaigns() {
  const now = new Date().toISOString();
  return [
    {
      id: "01HSEEDCPN0000000000000001",
      channel: "email",
      source: "resend",
      medium: "nurture",
      accountRef: "resend-account-acme",
      spend: 0,
      objective: "reactivate cold leads",
      status: "active",
      touchpointCount: 5,
      sent: 2,
      delivered: 1,
      opened: 1,
      clicked: 1,
      bounced: 0,
      createdAt: now,
      updatedAt: now,
    },
    {
      id: "01HSEEDCPN0000000000000002",
      channel: "paid_search",
      source: "google_ads",
      medium: "cpc",
      accountRef: "ga-123-456",
      spend: 12_000,
      objective: "inbound demo requests",
      status: "active",
      touchpointCount: 5,
      sent: 0,
      delivered: 0,
      opened: 0,
      clicked: 0,
      bounced: 0,
      createdAt: now,
      updatedAt: now,
    },
    {
      id: "01HSEEDCPN0000000000000003",
      channel: "outbound",
      source: "sdr_team",
      medium: "cold_email",
      accountRef: "team-sdr-a",
      spend: 2_500,
      objective: "enterprise pipeline",
      status: "active",
      touchpointCount: 5,
      sent: 0,
      delivered: 0,
      opened: 0,
      clicked: 0,
      bounced: 0,
      createdAt: now,
      updatedAt: now,
    },
  ];
}
