import { NextResponse, type NextRequest } from "next/server";
import { buildUpstreamHeaders } from "@/lib/upstream-headers";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * PATCH /api/marketing/campaigns/:id/steps/:stepId — update step
 * DELETE /api/marketing/campaigns/:id/steps/:stepId — remove step
 */
export async function PATCH(
  req: NextRequest,
  { params }: { params: { id: string; stepId: string } },
): Promise<Response> {
  const body = await req.text();
  return proxy(req, params.id, params.stepId, "PATCH", body);
}

export async function DELETE(
  req: NextRequest,
  { params }: { params: { id: string; stepId: string } },
): Promise<Response> {
  return proxy(req, params.id, params.stepId, "DELETE", null);
}

async function proxy(
  req: NextRequest,
  campaignId: string,
  stepId: string,
  method: "PATCH" | "DELETE",
  body: string | null,
): Promise<Response> {
  const upstream = process.env["VEX_API_URL"];
  if (upstream) {
    const url = `${upstream.replace(/\/$/, "")}/marketing/campaigns/${encodeURIComponent(campaignId)}/steps/${encodeURIComponent(stepId)}`;
    try {
      const headers = buildUpstreamHeaders(req);
      if (body) headers.set("content-type", "application/json");
      const res = await fetch(url, {
        method,
        headers,
        ...(body ? { body } : {}),
      });
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
  // Local dev stub — echo OK.
  if (method === "DELETE") return new Response(null, { status: 204 });
  const now = new Date().toISOString();
  return NextResponse.json({
    step: {
      id: stepId,
      campaignId,
      ...(body ? JSON.parse(body) : {}),
      updatedAt: now,
    },
  });
}
