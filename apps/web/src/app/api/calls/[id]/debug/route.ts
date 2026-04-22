import { NextResponse, type NextRequest } from "next/server";
import { buildUpstreamHeaders } from "@/lib/upstream-headers";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * GET /api/calls/:id/debug — proxy to apps/api
 * `GET /calls/:workflowId/debug`. Returns the full timeline: approval
 * + agent run + activity + every audit event keyed off the workflow
 * id, plus Temporal's live status.
 */
export async function GET(
  req: NextRequest,
  { params }: { params: { id: string } },
): Promise<Response> {
  const upstream = process.env["VEX_API_URL"];
  if (!upstream) {
    return NextResponse.json({
      workflowId: params.id,
      approval: null,
      agentRun: null,
      activity: null,
      events: [],
      workflow: null,
      stub: true,
    });
  }
  const url = `${upstream.replace(/\/$/, "")}/calls/${encodeURIComponent(params.id)}/debug`;
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
