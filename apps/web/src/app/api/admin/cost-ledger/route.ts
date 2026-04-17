import { NextResponse, type NextRequest } from "next/server";
import { buildUpstreamHeaders } from "@/lib/upstream-headers";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(req: NextRequest): Promise<Response> {
  const upstream = process.env["VEX_API_URL"];
  const qs = req.nextUrl.searchParams.toString();
  if (!upstream) return stub();
  const url = `${upstream.replace(/\/$/, "")}/admin/cost-ledger${qs ? `?${qs}` : ""}`;
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
  const from = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
  const entry = (
    minutesAgo: number,
    operation: string,
    agent: string,
    cost: number,
    tokensIn = 0,
    tokensOut = 0,
  ) => ({
    id: `stub-${minutesAgo}`,
    operation,
    provider: "anthropic",
    model: "claude-sonnet-4-20250514",
    agentRunId: `stub-run-${minutesAgo}`,
    agentName: agent,
    units: tokensIn + tokensOut,
    unitKind: "tokens",
    costUsd: cost,
    occurredAt: new Date(now.getTime() - minutesAgo * 60_000).toISOString(),
  });
  return NextResponse.json({
    window: { from: from.toISOString(), to: now.toISOString() },
    entries: [
      entry(5, "llm.completion", "daily_brief", 0.04),
      entry(48, "llm.completion", "research", 0.12),
      entry(120, "llm.completion", "follow_up", 0.02),
      entry(180, "llm.completion", "deal_evaluator", 0.08),
      entry(400, "llm.embedding", "research", 0.002),
    ],
    totals: { today: 0.26, week: 1.14, month: 3.84 },
  });
}
