import { NextResponse, type NextRequest } from "next/server";
import { buildUpstreamHeaders } from "@/lib/upstream-headers";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * POST /api/marketing/campaigns/:id/enroll — enroll a batch of
 * contacts into the campaign. Body: { contactIds: string[] }.
 */
export async function POST(
  req: NextRequest,
  { params }: { params: { id: string } },
): Promise<Response> {
  const upstream = process.env["VEX_API_URL"];
  const body = await req.text();
  if (upstream) {
    const url = `${upstream.replace(/\/$/, "")}/marketing/campaigns/${encodeURIComponent(params.id)}/enroll`;
    try {
      const headers = buildUpstreamHeaders(req);
      headers.set("content-type", "application/json");
      const res = await fetch(url, { method: "POST", headers, body });
      const text = await res.text();
      return new Response(text, {
        status: res.status,
        headers: {
          "content-type": res.headers.get("content-type") ?? "application/json",
        },
      });
    } catch (err) {
      return NextResponse.json(
        { error: "upstream_unavailable", message: (err as Error).message },
        { status: 502 },
      );
    }
  }
  let parsed: { contactIds?: string[] } = {};
  try {
    parsed = body ? (JSON.parse(body) as { contactIds?: string[] }) : {};
  } catch {
    return NextResponse.json(
      { error: "invalid_json", message: "POST body is not valid JSON" },
      { status: 400 },
    );
  }
  const count = Array.isArray(parsed.contactIds) ? parsed.contactIds.length : 0;
  return NextResponse.json({ created: count, existing: 0 }, { status: 201 });
}
