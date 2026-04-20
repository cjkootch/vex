import { NextResponse, type NextRequest } from "next/server";
import { buildUpstreamHeaders } from "@/lib/upstream-headers";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * Proxy for `POST /contacts/bulk-archive`. Body:
 *   { contactIds: string[], reason?: string }
 * Upstream returns: { archivedCount: number, archivedIds: string[] }
 *
 * Local-dev stub echoes back a plausible shape so the UI is
 * exercisable without VEX_API_URL set.
 */
export async function POST(req: NextRequest): Promise<Response> {
  const upstream = process.env["VEX_API_URL"];
  const body = await req.text();
  if (!upstream) {
    try {
      const parsed = JSON.parse(body) as { contactIds?: unknown };
      const ids = Array.isArray(parsed.contactIds)
        ? (parsed.contactIds as string[])
        : [];
      return NextResponse.json({
        archivedCount: ids.length,
        archivedIds: ids,
        stub: true,
      });
    } catch {
      return NextResponse.json({ error: "invalid_json" }, { status: 400 });
    }
  }
  const url = `${upstream.replace(/\/$/, "")}/contacts/bulk-archive`;
  try {
    const headers = buildUpstreamHeaders(req);
    headers.set("content-type", "application/json");
    const response = await fetch(url, { method: "POST", headers, body });
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
