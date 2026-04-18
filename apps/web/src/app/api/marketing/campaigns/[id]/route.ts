import { NextResponse, type NextRequest } from "next/server";
import { buildUpstreamHeaders } from "@/lib/upstream-headers";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * GET /api/marketing/campaigns/:id — proxy to apps/api
 * `GET /marketing/campaigns/:id`. Stubbed in local dev so the detail
 * page renders without a running API.
 */
export async function GET(
  req: NextRequest,
  { params }: { params: { id: string } },
): Promise<Response> {
  const upstream = process.env["VEX_API_URL"];

  if (upstream) {
    const url = `${upstream.replace(/\/$/, "")}/marketing/campaigns/${encodeURIComponent(params.id)}`;
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

  return NextResponse.json({ campaign: stubCampaign(params.id) });
}

function stubCampaign(id: string) {
  const now = new Date().toISOString();
  return {
    id,
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
    touchpoints: [
      {
        id: "01HSEEDTPT0000000000000001",
        channel: "email.sent",
        actor: "agent.composer",
        occurredAt: now,
        contactId: "01HSEEDCNT0000000000000001",
        orgId: "01HSEEDCRP0000000000000001",
        leadId: null,
        campaignId: id,
        metadata: { subject: "Touch #1" },
      },
    ],
  };
}
