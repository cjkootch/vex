import { NextResponse, type NextRequest } from "next/server";

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
        headers: forwardHeaders(req.headers),
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
    ],
  });
}

function forwardHeaders(src: Headers): Headers {
  const out = new Headers();
  const auth = src.get("authorization");
  if (auth) out.set("authorization", auth);
  return out;
}
