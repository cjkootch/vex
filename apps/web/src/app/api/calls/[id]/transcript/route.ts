import { NextResponse, type NextRequest } from "next/server";
import { buildUpstreamHeaders } from "@/lib/upstream-headers";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * GET /api/calls/:id/transcript — proxy to apps/api
 * `GET /calls/:workflowId/transcript`.
 *
 * Response: { transcript: string; summary: string | null }.
 */
export async function GET(
  req: NextRequest,
  { params }: { params: { id: string } },
): Promise<Response> {
  const upstream = process.env["VEX_API_URL"];
  if (upstream) {
    const url = `${upstream.replace(/\/$/, "")}/calls/${encodeURIComponent(params.id)}/transcript`;
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
    transcript:
      "Vex: Hello, this is Vex on behalf of Vector Trade Capital. Are you the right person to speak with about Q3 fuel procurement?\n\nBuyer: Yes, I handle that.",
    summary:
      "Confirmed procurement contact. Requested follow-up quote by Friday.",
  });
}
