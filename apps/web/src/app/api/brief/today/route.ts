import { NextResponse, type NextRequest } from "next/server";
import { buildUpstreamHeaders } from "@/lib/upstream-headers";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * GET /api/brief/today — proxy to the NestJS `GET /brief/today` on
 * apps/api. Matches the approvals / conversations proxy pattern:
 * when VEX_API_URL is set the request is lifted to the upstream with
 * the NextAuth cookie promoted to a Bearer; when unset the route
 * returns a canned stub so the /app home renders in local dev.
 *
 * Object IDs in the stub reference the seeded Sprint-11 deals
 * (DEAL_1_ID / DEAL_2_ID in packages/db/src/seed-ids.ts) so links
 * and chat follow-ups resolve against real rows once the seed is
 * loaded.
 */

// Matches SEED_FUEL_DEAL_IDS in packages/db/src/seed-ids.ts.
const DEAL_1_ID = "01HSEEDDEA0000000000000001";
const DEAL_2_ID = "01HSEEDDEA0000000000000002";

export async function GET(req: NextRequest): Promise<Response> {
  const upstream = process.env["VEX_API_URL"];
  if (upstream) {
    const url = `${upstream.replace(/\/$/, "")}/brief/today`;
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

  return NextResponse.json(stubBrief());
}

function stubBrief() {
  const now = new Date();
  return {
    id: "stub-brief-001",
    tenantId: "01HSEEDWRK0000000000000001",
    generatedAt: now.toISOString(),
    greeting: "Here's what needs your attention today.",
    priorities: [
      {
        id: "p1",
        title: "Follow up with Massy — 7 days silent",
        reason: "Last touchpoint was an email click. No call booked.",
        objectType: "deal",
        objectId: DEAL_1_ID,
        objectRef: "VTC-2026-001",
        urgency: "high",
        suggestedAction: "Send check-in email",
      },
      {
        id: "p2",
        title: "OFAC screening incomplete on VTC-2026-001",
        reason:
          "Deal is in negotiating status. Cannot proceed without clearance.",
        objectType: "deal",
        objectId: DEAL_1_ID,
        objectRef: "VTC-2026-001",
        urgency: "high",
      },
    ],
    handled: [
      {
        id: "h1",
        agentName: "research",
        summary: "Researched 3 Caribbean importers from USDA referral list",
        completedAt: new Date(Date.now() - 2 * 3600_000).toISOString(),
        costUsd: 0.04,
      },
    ],
    blocked: [
      {
        id: "b1",
        summary: "Cannot send follow-up to Kenny — compliance hold active",
        reason: "OFAC screening not cleared for Kenge Enterprises Corp",
        objectType: "deal",
        objectId: DEAL_1_ID,
        resolution: "Complete OFAC screening in the compliance tab",
      },
    ],
    ownerOnly: [],
    pipeline: [
      {
        dealId: DEAL_1_ID,
        dealRef: "VTC-2026-001",
        product: "ulsd",
        buyer: "Massy Jamaica",
        status: "negotiating",
        ebitdaUsd: 214_000,
        score: 55,
        recommendation: "marginal",
        daysSinceLastTouch: 7,
        criticalWarningCount: 2,
      },
      {
        dealId: DEAL_2_ID,
        dealRef: "VTC-2026-002",
        product: "ulsd",
        buyer: "Caribbean Importer Co",
        status: "approved",
        ebitdaUsd: 487_000,
        score: 78,
        recommendation: "acceptable",
        daysSinceLastTouch: 1,
        criticalWarningCount: 0,
      },
    ],
    risks: [
      {
        id: "r1",
        title: "Vessel utilization at 14% on VTC-2026-001",
        severity: "high",
        description:
          "Freight cost is $0.64/USG above optimal. Deal margin is thin.",
        objectType: "deal",
        objectId: DEAL_1_ID,
      },
    ],
    recommendedFocus:
      "Resolve the VTC-2026-001 OFAC hold and fill the vessel before laycan.",
    totalAgentCostToday: 0.14,
    pendingApprovalCount: 3,
  };
}
