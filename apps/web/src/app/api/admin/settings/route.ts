import { NextResponse, type NextRequest } from "next/server";
import { buildUpstreamHeaders } from "@/lib/upstream-headers";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * Proxy to apps/api `/admin/settings`.
 *   GET    → current WorkspaceSettings
 *   PATCH  → partial update (Zod-validated upstream)
 *
 * Local-dev stub returns a reasonable shape so the admin console
 * renders without VEX_API_URL set.
 */

type Handler = "GET" | "PATCH";

async function proxy(req: NextRequest, method: Handler): Promise<Response> {
  const upstream = process.env["VEX_API_URL"];
  if (!upstream) return stub(req, method);
  const url = `${upstream.replace(/\/$/, "")}/admin/settings`;
  try {
    const headers = buildUpstreamHeaders(req);
    if (method === "PATCH") headers.set("content-type", "application/json");
    const init: RequestInit = { method, headers };
    if (method === "PATCH") init.body = await req.text();
    const response = await fetch(url, init);
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

export async function GET(req: NextRequest): Promise<Response> {
  return proxy(req, "GET");
}

export async function PATCH(req: NextRequest): Promise<Response> {
  return proxy(req, "PATCH");
}

async function stub(req: NextRequest, method: Handler): Promise<Response> {
  const base = {
    source_priority: ["internal", "apollo", "ga4", "resend"],
    enabled_agents: ["daily_brief", "follow_up", "qualifier", "composer"],
    daily_cost_limit: 5,
    kill_all_agents: false,
    feature_rollout: { voice_alpha: 25, outbound_call: 10 },
    sharing_enabled: false,
  };
  if (method === "GET") {
    return NextResponse.json({ settings: base });
  }
  try {
    const patch = (await req.json()) as Record<string, unknown>;
    return NextResponse.json({
      settings: { ...base, ...patch },
      stub: true,
    });
  } catch {
    return NextResponse.json(
      { error: "invalid_json_body" },
      { status: 400 },
    );
  }
}
