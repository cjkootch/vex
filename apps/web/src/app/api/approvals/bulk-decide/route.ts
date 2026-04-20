import { NextResponse, type NextRequest } from "next/server";
import { buildUpstreamHeaders } from "@/lib/upstream-headers";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * Proxies POST /approvals/bulk-decide to apps/api. Body shape:
 *   { ids: string[], decision: "approve" | "reject", reason?: string }
 * When VEX_API_URL is unset (local dev), echoes back a canned result
 * so the inbox UI's bulk flow stays interactive.
 */
export async function POST(req: NextRequest): Promise<Response> {
  const upstream = process.env["VEX_API_URL"];
  if (upstream) {
    const url = `${upstream.replace(/\/$/, "")}/approvals/bulk-decide`;
    try {
      const headers = buildUpstreamHeaders(req);
      headers.set("content-type", "application/json");
      const response = await fetch(url, {
        method: "POST",
        headers,
        body: await req.text(),
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

  const raw = (await req.json().catch(() => ({}))) as {
    ids?: string[];
    decision?: string;
  };
  const ids = Array.isArray(raw.ids) ? raw.ids : [];
  return NextResponse.json({
    decided: ids.map((id) => ({
      id,
      decision: raw.decision === "reject" ? "rejected" : "approved",
      decidedAt: new Date().toISOString(),
    })),
    skipped: [],
  });
}
