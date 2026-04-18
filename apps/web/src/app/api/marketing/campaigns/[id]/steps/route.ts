import { NextResponse, type NextRequest } from "next/server";
import { buildUpstreamHeaders } from "@/lib/upstream-headers";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * GET /api/marketing/campaigns/:id/steps — list plan steps.
 * POST /api/marketing/campaigns/:id/steps — add a new step.
 *
 * Both proxy to apps/api. Stubbed list when VEX_API_URL is unset so
 * the Plan editor renders in local dev.
 */
export async function GET(
  req: NextRequest,
  { params }: { params: { id: string } },
): Promise<Response> {
  return proxy(req, params.id, "GET", null);
}

export async function POST(
  req: NextRequest,
  { params }: { params: { id: string } },
): Promise<Response> {
  const body = await req.text();
  return proxy(req, params.id, "POST", body);
}

async function proxy(
  req: NextRequest,
  campaignId: string,
  method: "GET" | "POST",
  body: string | null,
): Promise<Response> {
  const upstream = process.env["VEX_API_URL"];
  if (upstream) {
    const url = `${upstream.replace(/\/$/, "")}/marketing/campaigns/${encodeURIComponent(campaignId)}/steps`;
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
  if (method === "GET") {
    return NextResponse.json({ steps: [], validation: "plan has no steps" });
  }
  // Stub POST — echo back a synthetic step so the editor round-trips.
  const parsed = body ? (JSON.parse(body) as Record<string, unknown>) : {};
  const now = new Date().toISOString();
  return NextResponse.json(
    {
      step: {
        id: `01HSTUBSTP${Math.random().toString(36).slice(2, 14).toUpperCase().padEnd(14, "0")}`,
        campaignId,
        position: Number(parsed["position"] ?? 0),
        channel: String(parsed["channel"] ?? "email"),
        delayAfterPriorMs: Number(parsed["delayAfterPriorMs"] ?? 0),
        templateRef: (parsed["templateRef"] as string | undefined) ?? null,
        gateConditionJson:
          (parsed["gateConditionJson"] as Record<string, unknown> | undefined) ?? {},
        tier: String(parsed["tier"] ?? "T2"),
        autoApprove: Boolean(parsed["autoApprove"] ?? false),
        createdAt: now,
        updatedAt: now,
      },
    },
    { status: 201 },
  );
}
