import { NextResponse, type NextRequest } from "next/server";
import { buildUpstreamHeaders } from "@/lib/upstream-headers";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * DELETE /api/contacts/:id/memberships/:orgId — proxy to apps/api.
 * Removes a non-primary membership. Upstream refuses if the target is
 * primary or if it's the last remaining membership.
 */
export async function DELETE(
  req: NextRequest,
  { params }: { params: { id: string; orgId: string } },
): Promise<Response> {
  const upstream = process.env["VEX_API_URL"];

  if (upstream) {
    const url = `${upstream.replace(/\/$/, "")}/contacts/${encodeURIComponent(params.id)}/memberships/${encodeURIComponent(params.orgId)}`;
    try {
      const response = await fetch(url, {
        method: "DELETE",
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

  return NextResponse.json({ stub: true, contactId: params.id, orgId: params.orgId });
}
