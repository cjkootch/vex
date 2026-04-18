import { NextResponse, type NextRequest } from "next/server";
import { buildUpstreamHeaders } from "@/lib/upstream-headers";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * Sprint-6 stub. Real list endpoint lives at apps/api `GET /approvals`.
 * Proxies through when `process.env.VEX_API_URL` is set; otherwise returns
 * a small canned set so the inbox UI is interactive in local dev.
 */
export async function GET(req: NextRequest): Promise<Response> {
  const upstream = process.env["VEX_API_URL"];
  if (upstream) {
    const status = req.nextUrl.searchParams.get("status") ?? "pending";
    const url = `${upstream.replace(/\/$/, "")}/approvals?status=${encodeURIComponent(status)}`;
    try {
      const response = await fetch(url, {
        headers: buildUpstreamHeaders(req),
      });
      const body = await response.text();
      return new Response(body, {
        status: response.status,
        headers: { "content-type": response.headers.get("content-type") ?? "application/json" },
      });
    } catch (err) {
      return NextResponse.json(
        { error: "upstream_unavailable", message: (err as Error).message },
        { status: 502 },
      );
    }
  }

  return NextResponse.json({
    approvals: [
      {
        id: "01HSEEDAPV0000000000000001",
        actionType: "follow_up.suggestion",
        decision: "pending",
        createdAt: new Date(Date.now() - 30 * 60 * 1000).toISOString(),
        proposedPayload: {
          subject_type: "lead",
          subject_id: "01HSEEDDEA0000000000000001",
          subject_line: "Quick check-in on the Acme proposal",
          opening_line:
            "Hey — wanted to follow up on the deck we shared last week.",
          channel: "email",
          tier: "T1",
        },
      },
      {
        id: "01HSEEDAPV0000000000000002",
        actionType: "follow_up.suggestion",
        decision: "pending",
        createdAt: new Date(Date.now() - 90 * 60 * 1000).toISOString(),
        proposedPayload: {
          subject_type: "thread",
          subject_id: "01HSEEDTHRZ000000000000001",
          subject_line: "Did you have any questions on the pricing?",
          opening_line:
            "Following up on the call — happy to walk through anything that wasn't clear.",
          channel: "email",
          tier: "T1",
        },
      },
      {
        id: "01HSEEDAPV0000000000000004",
        actionType: "call.request_backup",
        decision: "pending",
        createdAt: new Date(Date.now() - 2 * 60 * 1000).toISOString(),
        proposedPayload: {
          tier: "T2",
          workflow_id: "outbound-call-01HSEEDRUN0000000000000099",
          call_sid: "CAXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX",
          duration_at_request_seconds: 182,
          callee_contact_id: "01HSEEDCNT0000000000000001",
          reason: "caller asked to speak to a manager",
          initiated_by: "01HSEEDUSR0000000000000001",
        },
      },
      {
        id: "01HSEEDAPV0000000000000003",
        actionType: "campaign.enroll_batch",
        decision: "pending",
        createdAt: new Date(Date.now() - 10 * 60 * 1000).toISOString(),
        proposedPayload: {
          tier: "T2",
          campaign_id: "01HSEEDCPN0000000000000001",
          contact_ids: [
            "01HSEEDCNT0000000000000001",
            "01HSEEDCNT0000000000000002",
            "01HSEEDCNT0000000000000003",
          ],
          recipient_count: 3,
          plan_summary: [
            {
              position: 0,
              channel: "email",
              tier: "T2",
              auto_approve: true,
              delay_after_prior_ms: 0,
            },
            {
              position: 1,
              channel: "sms",
              tier: "T2",
              auto_approve: false,
              delay_after_prior_ms: 3 * 86_400_000,
            },
            {
              position: 2,
              channel: "voice",
              tier: "T3",
              auto_approve: false,
              delay_after_prior_ms: 7 * 86_400_000,
            },
          ],
          rationale: "spring nurture batch — Acme lookalikes",
        },
      },
    ],
  });
}

