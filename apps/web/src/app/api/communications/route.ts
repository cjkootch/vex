import { NextResponse, type NextRequest } from "next/server";
import { buildUpstreamHeaders } from "@/lib/upstream-headers";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * GET /api/communications — Next proxy for the apps/api
 * `GET /communications` inbox feed. Passes through channel /
 * direction / contact_id / campaign_id / before / limit query params.
 *
 * When `VEX_API_URL` is unset (local dev without apps/api), returns a
 * tiny canned set so the Inbox page is interactive end-to-end.
 */
export async function GET(req: NextRequest): Promise<Response> {
  const upstream = process.env["VEX_API_URL"];
  if (upstream) {
    const qs = req.nextUrl.searchParams.toString();
    const url = `${upstream.replace(/\/$/, "")}/communications${qs ? `?${qs}` : ""}`;
    try {
      const response = await fetch(url, {
        headers: buildUpstreamHeaders(req),
      });
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

  // Local-dev stub — four items across all four channels so the UI
  // surfaces every branch without needing a seeded DB.
  const now = Date.now();
  return NextResponse.json({
    items: [
      {
        kind: "call",
        id: "01HSTUBACT00000000000000AA",
        occurredAt: new Date(now - 5 * 60_000).toISOString(),
        contactId: "01HSEEDCNT0000000000000001",
        workflowId: "outbound-call-01HSEEDRUN0000000000000099",
        callSid: "CAXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX",
        status: "in-progress",
        durationSeconds: null,
        transcriptRef: null,
      },
      {
        kind: "touchpoint",
        id: "01HSTUBTP00000000000000EMAIL",
        channel: "email.opened",
        channelGroup: "email",
        direction: "inbound",
        occurredAt: new Date(now - 45 * 60_000).toISOString(),
        contactId: "01HSEEDCNT0000000000000001",
        campaignId: "01HSEEDCPN0000000000000001",
        preview: "Re: your message on the Acme proposal",
        metadata: { subject: "Re: your message on the Acme proposal" },
      },
      {
        kind: "touchpoint",
        id: "01HSTUBTP00000000000000SMS",
        channel: "sms.sent",
        channelGroup: "sms",
        direction: "outbound",
        occurredAt: new Date(now - 2 * 3_600_000).toISOString(),
        contactId: "01HSEEDCNT0000000000000002",
        campaignId: null,
        preview:
          "Hey — quick follow-up on the trade you mentioned last week. Free to chat tomorrow?",
        metadata: { body: "..." },
      },
      {
        kind: "touchpoint",
        id: "01HSTUBTP00000000000000WAPP",
        channel: "whatsapp.delivered",
        channelGroup: "whatsapp",
        direction: "outbound",
        occurredAt: new Date(now - 6 * 3_600_000).toISOString(),
        contactId: "01HSEEDCNT0000000000000003",
        campaignId: "01HSEEDCPN0000000000000001",
        preview: "Quick heads-up on the batch you asked about",
        metadata: {},
      },
    ],
    nextBefore: null,
  });
}
