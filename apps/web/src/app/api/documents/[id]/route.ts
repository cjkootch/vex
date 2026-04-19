import { NextResponse, type NextRequest } from "next/server";
import { buildUpstreamHeaders } from "@/lib/upstream-headers";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * DELETE /api/documents/:id — proxy to apps/api, removes the row.
 * S3 object cleanup is best-effort inside the upstream service.
 */
export async function DELETE(
  req: NextRequest,
  ctx: { params: { id: string } },
): Promise<Response> {
  const upstream = process.env["VEX_API_URL"];
  if (!upstream) {
    return new Response(null, { status: 204 });
  }
  const url = `${upstream.replace(/\/$/, "")}/documents/${encodeURIComponent(ctx.params.id)}`;
  try {
    const response = await fetch(url, {
      method: "DELETE",
      headers: buildUpstreamHeaders(req),
    });
    return new Response(null, { status: response.status });
  } catch (err) {
    return NextResponse.json(
      { error: "upstream_unavailable", message: (err as Error).message },
      { status: 502 },
    );
  }
}
