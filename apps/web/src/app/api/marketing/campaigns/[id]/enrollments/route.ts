import { NextResponse, type NextRequest } from "next/server";
import { buildUpstreamHeaders } from "@/lib/upstream-headers";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * GET /api/marketing/campaigns/:id/enrollments — list enrollments
 * for the campaign. Forwards `state` + `limit` query params.
 */
export async function GET(
  req: NextRequest,
  { params }: { params: { id: string } },
): Promise<Response> {
  const upstream = process.env["VEX_API_URL"];
  const incoming = new URL(req.url);

  if (upstream) {
    const forwarded = new URLSearchParams();
    for (const key of ["state", "limit"] as const) {
      const value = incoming.searchParams.get(key);
      if (value) forwarded.set(key, value);
    }
    const qs = forwarded.toString();
    const url = `${upstream.replace(/\/$/, "")}/marketing/campaigns/${encodeURIComponent(params.id)}/enrollments${qs ? `?${qs}` : ""}`;
    try {
      const res = await fetch(url, { headers: buildUpstreamHeaders(req) });
      const text = await res.text();
      return new Response(text, {
        status: res.status,
        headers: {
          "content-type": res.headers.get("content-type") ?? "application/json",
        },
      });
    } catch (err) {
      return NextResponse.json(
        { error: "upstream_unavailable", message: (err as Error).message },
        { status: 502 },
      );
    }
  }
  // Local-dev stub — two synthetic enrollments so the branch-history
  // timeline has something to render without a running API.
  const now = new Date();
  const iso = (mins: number): string =>
    new Date(now.getTime() - mins * 60_000).toISOString();
  return NextResponse.json({
    enrollments: [
      {
        id: "01HSTUBENR0000000000000001",
        campaignId: params.id,
        contactId: "01HSEEDCNT0000000000000001",
        currentStep: 2,
        state: "enrolled",
        lastEventAt: iso(30),
        branchHistoryJson: [
          {
            step_id: "s0",
            position: 0,
            outcome: "auto_approved",
            approval_id: "01HAPP0000000000000000001A",
          },
          {
            step_id: "s1",
            position: 1,
            outcome: "skipped_gate",
            gate_reason: "opened_in_last_days: no hit in last 7d",
          },
        ],
        error: null,
        createdAt: iso(240),
        updatedAt: iso(30),
      },
      {
        id: "01HSTUBENR0000000000000002",
        campaignId: params.id,
        contactId: "01HSEEDCNT0000000000000002",
        currentStep: 1,
        state: "paused",
        lastEventAt: iso(90),
        branchHistoryJson: [
          {
            step_id: "s0",
            position: 0,
            outcome: "approved",
            approval_id: "01HAPP0000000000000000001B",
          },
        ],
        error: "reviewer rejected step approval",
        createdAt: iso(180),
        updatedAt: iso(90),
      },
    ],
    counts: { enrolled: 1, completed: 0, paused: 1, unsubscribed: 0, errored: 0 },
  });
}
