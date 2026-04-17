import { NextResponse, type NextRequest } from "next/server";
import { buildUpstreamHeaders } from "@/lib/upstream-headers";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * Proxy to apps/api `GET /admin/health`. Returns the 7-day agent-run
 * roll-up used by the admin console's Health tab.
 */
export async function GET(req: NextRequest): Promise<Response> {
  const upstream = process.env["VEX_API_URL"];
  if (!upstream) return stub();
  const url = `${upstream.replace(/\/$/, "")}/admin/health`;
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

function stub(): Response {
  const to = new Date();
  const from = new Date(to.getTime() - 7 * 24 * 60 * 60 * 1000);
  return NextResponse.json({
    window: { from: from.toISOString(), to: to.toISOString() },
    totalRuns: 188,
    completed: 172,
    failed: 8,
    failureRate: 0.0425,
    avgDurationSeconds: 4.1,
    totalCostUsd: 3.84,
    byAgent: [
      {
        agentName: "daily_brief",
        runs: 21,
        failures: 1,
        totalCostUsd: 0.42,
        avgDurationSeconds: 5.9,
      },
      {
        agentName: "follow_up",
        runs: 84,
        failures: 3,
        totalCostUsd: 1.6,
        avgDurationSeconds: 3.1,
      },
      {
        agentName: "research",
        runs: 62,
        failures: 2,
        totalCostUsd: 1.52,
        avgDurationSeconds: 4.8,
      },
      {
        agentName: "deal_evaluator",
        runs: 15,
        failures: 1,
        totalCostUsd: 0.28,
        avgDurationSeconds: 2.6,
      },
      {
        agentName: "outbound_call",
        runs: 6,
        failures: 1,
        totalCostUsd: 0.02,
        avgDurationSeconds: 180,
      },
    ],
  });
}
