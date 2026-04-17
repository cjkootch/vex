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

  // Local-dev stub
  return NextResponse.json({
    workflowId: params.id,
    approval: { id: `stub-approval-${params.id}`, decision: "pending" },
    activity: null,
    workflow: { status: "RUNNING" },
    stub: true,
  });
}
