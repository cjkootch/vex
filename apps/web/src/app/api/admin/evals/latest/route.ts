import { NextResponse, type NextRequest } from "next/server";
import { buildUpstreamHeaders } from "@/lib/upstream-headers";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * Proxy to apps/api `GET /admin/evals/latest`. Upstream reads
 * evals/results/latest.json and returns { status, results? }.
 */
export async function GET(req: NextRequest): Promise<Response> {
  const upstream = process.env["VEX_API_URL"];
  if (!upstream) return stub();
  const url = `${upstream.replace(/\/$/, "")}/admin/evals/latest`;
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
  const now = new Date();
  return NextResponse.json({
    status: "ok",
    results: {
      runAt: now.toISOString(),
      totalFixtures: 25,
      passed: 22,
      failed: 3,
      passRate: 0.88,
      regressions: [],
      fixtures: [
        { id: "eval_001", question: "Find the organization named Acme Corporation.", passed: true },
        { id: "eval_002", question: "Which contact has the email contact2@example1.test?", passed: true },
        { id: "eval_011", question: "Run the daily brief for the demo workspace…", passed: true },
        { id: "eval_deal_001", question: "What is the net margin per gallon on VTC-2026-001?", passed: true },
        { id: "eval_deal_002", question: "Which deals have vessel utilization below 50%?", passed: false, errors: ["answer did not mention 'utilization'"] },
        { id: "eval_deal_003", question: "Deals with compliance holds or OFAC not cleared.", passed: true },
        { id: "eval_call_001", question: "Outbound call to suppressed contact is rejected.", passed: false, errors: ["expected event call.rejected.suppressed"] },
        { id: "eval_cost_limit_001", question: "Agent is skipped when daily cost limit is reached.", passed: false, errors: ["agent ran despite cap"] },
      ],
    },
  });
}
