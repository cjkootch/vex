import { NextResponse, type NextRequest } from "next/server";
import { buildUpstreamHeaders } from "@/lib/upstream-headers";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * Proxy to apps/api `POST /strategy/draft-slot`.
 *
 * Local-dev stub returns a seed-flavoured draft per slot so the
 * "Help me write this" UI is exercisable without VEX_API_URL set.
 */

export async function POST(req: NextRequest): Promise<Response> {
  const upstream = process.env["VEX_API_URL"];
  if (!upstream) return stub(req);
  const url = `${upstream.replace(/\/$/, "")}/strategy/draft-slot`;
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

async function stub(req: NextRequest): Promise<Response> {
  let body: { slot?: string; hints?: string };
  try {
    body = (await req.json()) as { slot?: string; hints?: string };
  } catch {
    return NextResponse.json({ error: "invalid_json_body" }, { status: 400 });
  }
  const draft = DEV_DRAFTS[body.slot ?? ""];
  if (draft === undefined) {
    return NextResponse.json({ error: "unknown_slot" }, { status: 400 });
  }
  return NextResponse.json({ draft, stub: true });
}

const DEV_DRAFTS: Record<string, string | string[]> = {
  mission:
    "Partner with commodity traders in underserved Caribbean and Central American corridors to move fuel and food at scale, with the logistics discipline and counterparty rigor of a much larger house.",
  target_markets: [
    "Jamaica",
    "Trinidad & Tobago",
    "Dominican Republic",
    "Haiti",
    "Guyana",
  ],
  icp_buyers:
    "Mid-size national fuel distributors (1-5M USG/month) and government food importers with LC access, concentrated on Caribbean islands. Prefer counterparties that have traded ULSD, jet, or parboiled rice in the last 18 months and can underwrite to T2 tier or better.",
  icp_suppliers:
    "Gulf Coast refineries with Caribbean panamax routing, rice mills in the US Sun Belt or Thailand with bagged-export lanes, and mid-tier pork processors with cold-chain plus USDA-export credentialing. Must quote FOB or CFR and accept LC at sight or 60d.",
  brand_voice:
    "Peer-to-peer operator voice. Direct, numeric, concrete. Use trader shorthand (ATB, laycan, demurrage) when the counterparty will follow it. No marketing superlatives, no filler. Open with the number, not the pleasantry.",
  pricing_philosophy:
    "Margin floor of $0.02/USG on fuel, 3.5% gross on food cargoes. LC at sight unless the buyer is Tier 1 in which case 30-60d open. No speculative buys without a letter of intent or prepayment for food; fuel can run on the Argus differential with a 5-day indication window.",
  no_go_zones: [
    "OFAC-sanctioned counterparties",
    "Cuba",
    "Venezuela crude",
    "Any entity without KYC packet within 5 business days",
  ],
  growth_priorities: [
    "Land 3 new Caribbean rice buyers this quarter",
    "Open 2 pork suppliers in the US Midwest",
    "Qualify 5 ULSD buyers in Trinidad + Jamaica",
    "Close one government food tender",
  ],
  additional_guidance:
    "Always surface counterparty risk tier in the first reply when a new org comes up in chat. Prefer voice calls over email for Tier 1 buyers — they close faster on the phone. When drafting emails in Spanish or French, mirror the formality of the last inbound from that contact.",
};
