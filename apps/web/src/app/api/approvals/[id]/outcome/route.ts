import { NextResponse, type NextRequest } from "next/server";
import { buildUpstreamHeaders } from "@/lib/upstream-headers";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * Proxies GET /approvals/:id/outcome to apps/api. Returns the
 * executor-outcome payload so the UI can render "applied" / "failed:
 * <reason>" / "queued" on decided approvals.
 */
export async function GET(
  req: NextRequest,
  { params }: { params: { id: string } },
): Promise<Response> {
  const upstream = process.env["VEX_API_URL"];
  if (upstream) {
    const url = `${upstream.replace(/\/$/, "")}/approvals/${encodeURIComponent(params.id)}/outcome`;
    try {
      const response = await fetch(url, {
        headers: buildUpstreamHeaders(req),
      });
      const body = await response.text();
      return new Response(body, {
        status: response.status,
        headers: {
          "content-type": response.headers.get("content-type") ?? "application/json",
        },
      });
    } catch (err) {
      return NextResponse.json(
        { error: "upstream_unavailable", message: (err as Error).message },
        { status: 502 },
      );
    }
  }

  // Local dev echo.
  return NextResponse.json({ outcome: { status: "queued", reason: null } });
}
