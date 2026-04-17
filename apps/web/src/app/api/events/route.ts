import { NextResponse, type NextRequest } from "next/server";
import { buildUpstreamHeaders } from "@/lib/upstream-headers";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * GET /api/events — proxy to apps/api `GET /events`. Forwards
 * `subject_type`, `subject_id`, `limit`, `before` query params. Used by
 * the per-entity ActivityTimeline component.
 */
export async function GET(req: NextRequest): Promise<Response> {
  const upstream = process.env["VEX_API_URL"];
  const incoming = new URL(req.url);

  if (upstream) {
    const forwarded = new URLSearchParams();
    for (const key of ["subject_type", "subject_id", "limit", "before"] as const) {
      const value = incoming.searchParams.get(key);
      if (value) forwarded.set(key, value);
    }
    const qs = forwarded.toString();
    const url = `${upstream.replace(/\/$/, "")}/events${qs ? `?${qs}` : ""}`;
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

  return NextResponse.json({ events: stubEvents() });
}

function stubEvents() {
  // Three canned events so the detail page shows a populated timeline
  // against the demo stub deals in local dev.
  const now = Date.now();
  return [
    {
      id: "01HEVT0000000000000000001",
      verb: "deal.status_change_requested",
      subjectType: "fuel_deal",
      subjectId: "01HSEEDDEA0000000000000001",
      actorType: "user",
      actorId: "01HSEEDPRS0000000000000001",
      objectType: "approval",
      objectId: "01HAPP0000000000000000001",
      occurredAt: new Date(now - 2 * 3600 * 1000).toISOString(),
      metadata: {
        deal_ref: "VTC-2026-001",
        from_status: "negotiating",
        to_status: "approved",
        rationale: "OFAC cleared; LC draft signed",
      },
    },
    {
      id: "01HEVT0000000000000000002",
      verb: "deal.evaluated",
      subjectType: "fuel_deal",
      subjectId: "01HSEEDDEA0000000000000001",
      actorType: "agent",
      actorId: "deal_evaluator",
      objectType: "fuel_deal",
      objectId: "01HSEEDDEA0000000000000001",
      occurredAt: new Date(now - 8 * 3600 * 1000).toISOString(),
      metadata: {
        score: 55,
        recommendation: "marginal",
        critical_warnings: 2,
      },
    },
    {
      id: "01HEVT0000000000000000003",
      verb: "deal.created",
      subjectType: "fuel_deal",
      subjectId: "01HSEEDDEA0000000000000001",
      actorType: "user",
      actorId: "01HSEEDPRS0000000000000001",
      objectType: "fuel_deal",
      objectId: "01HSEEDDEA0000000000000001",
      occurredAt: new Date(now - 48 * 3600 * 1000).toISOString(),
      metadata: {
        deal_ref: "VTC-2026-001",
        product: "ulsd",
        buyer_org_id: "01HSEEDCRP0000000000000006",
        volume_usg: 3200000,
      },
    },
  ];
}
