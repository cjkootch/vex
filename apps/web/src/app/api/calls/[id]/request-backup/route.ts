import { NextResponse, type NextRequest } from "next/server";
import { buildUpstreamHeaders } from "@/lib/upstream-headers";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * POST /api/calls/:id/request-backup — Sprint I. Proxies to apps/api
 * `POST /calls/:workflowId/request-backup`. Body: { reason?: string }.
 * Returns { approvalId, existed }.
 */
export async function POST(
  req: NextRequest,
  { params }: { params: { id: string } },
): Promise<Response> {
  const upstream = process.env["VEX_API_URL"];
  const body = await req.text();
  if (upstream) {
    const url = `${upstream.replace(/\/$/, "")}/calls/${encodeURIComponent(params.id)}/request-backup`;
    try {
      const headers = buildUpstreamHeaders(req);
      headers.set("content-type", "application/json");
      const response = await fetch(url, {
        method: "POST",
        headers,
        body: body.length > 0 ? body : "{}",
      });
      const text = await response.text();
      return new Response(text, {
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

  // Local-dev stub — a canned approval id so the caller can branch
  // the same way it would against a real upstream.
  return NextResponse.json(
    {
      approvalId: `01HSTUBBKP${Math.random()
        .toString(36)
        .slice(2, 16)
        .toUpperCase()
        .padEnd(16, "0")}`,
      existed: false,
    },
    { status: 201 },
  );
}
