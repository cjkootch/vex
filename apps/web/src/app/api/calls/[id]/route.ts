import { NextResponse, type NextRequest } from "next/server";
import { buildUpstreamHeaders } from "@/lib/upstream-headers";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * GET /api/calls/:id — proxy to apps/api `GET /calls/:workflowId`.
 * Returns { workflowId, approval, activity, workflow? }.
 *
 * Local-dev stub when VEX_API_URL is unset — the shape matches the
 * upstream contract so the UI doesn't branch on env.
 */
export async function GET(
  req: NextRequest,
  { params }: { params: { id: string } },
): Promise<Response> {
  const upstream = process.env["VEX_API_URL"];
  if (upstream) {
    const url = `${upstream.replace(/\/$/, "")}/calls/${encodeURIComponent(params.id)}`;
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

  // Local-dev stub — realistic in-progress call so the Sprint I
  // detail page renders with live duration, callee, and status
  // without a running apps/api.
  const startedAt = new Date(Date.now() - 2 * 60_000).toISOString();
  return NextResponse.json({
    workflowId: params.id,
    approval: { id: `stub-approval-${params.id}`, decision: "pending" },
    activity: {
      id: "01HSTUBACT0000000000000001",
      callSid: "CAXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX",
      status: "in-progress",
      durationSeconds: null,
      transcriptRef: null,
      startedAt,
    },
    callee: {
      id: "01HSEEDCNT0000000000000001",
      fullName: "Dana Reyes",
      phone: "+15555551234",
    },
    workflow: { status: "RUNNING" },
    stub: true,
  });
}
