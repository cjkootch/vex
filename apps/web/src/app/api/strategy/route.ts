import { NextResponse, type NextRequest } from "next/server";
import { buildUpstreamHeaders } from "@/lib/upstream-headers";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * Proxy to apps/api `/strategy`.
 *   GET  → current WorkspaceStrategy
 *   PUT  → overwrite (Zod-validated upstream)
 *
 * Local-dev stub returns a seed-ish strategy so /app/strategy
 * renders without VEX_API_URL set.
 */

type Handler = "GET" | "PUT";

async function proxy(req: NextRequest, method: Handler): Promise<Response> {
  const upstream = process.env["VEX_API_URL"];
  if (!upstream) return stub(req, method);
  const url = `${upstream.replace(/\/$/, "")}/strategy`;
  try {
    const headers = buildUpstreamHeaders(req);
    if (method === "PUT") headers.set("content-type", "application/json");
    const init: RequestInit = { method, headers };
    if (method === "PUT") init.body = await req.text();
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

export async function PUT(req: NextRequest): Promise<Response> {
  return proxy(req, "PUT");
}

async function stub(req: NextRequest, method: Handler): Promise<Response> {
  const base = {
    mission:
      "Partner with emerging-market commodity traders to move fuel and food at scale across underserved Caribbean + Central American corridors.",
    target_markets: ["Caribbean", "Central America", "US Gulf"],
    icp_buyers:
      "Mid-size national fuel distributors, government food importers, Caribbean bunkering operations.",
    icp_suppliers:
      "Refineries with Caribbean logistics; rice / pork mills with bagged-export capability; mid-tier food wholesalers with cold-chain ops.",
    brand_voice:
      "Peer-to-peer operators. Direct, outcome-focused, no marketing-speak. Write like a trader talking to another trader.",
    pricing_philosophy:
      "Index-linked with margin floor; LC-backed unless the counterparty is Tier 1. No spec cargoes without production confirmation.",
    no_go_zones: ["OFAC-sanctioned counterparties", "Cuba", "Venezuela crude"],
    growth_priorities: [
      "Land 3 new Caribbean rice buyers",
      "Open 2 pork suppliers in US Midwest",
      "Qualify 5 ULSD buyers in Trinidad + Jamaica",
    ],
    additional_guidance: "",
    updated_at: new Date().toISOString(),
    updated_by: null,
  };
  if (method === "GET") {
    return NextResponse.json({ strategy: base });
  }
  try {
    const incoming = (await req.json()) as Record<string, unknown>;
    return NextResponse.json({
      strategy: {
        ...base,
        ...incoming,
        updated_at: new Date().toISOString(),
      },
      stub: true,
    });
  } catch {
    return NextResponse.json(
      { error: "invalid_json_body" },
      { status: 400 },
    );
  }
}
