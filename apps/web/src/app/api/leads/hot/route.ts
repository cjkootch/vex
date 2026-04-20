import { NextResponse, type NextRequest } from "next/server";
import { buildUpstreamHeaders } from "@/lib/upstream-headers";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * Proxy to apps/api `GET /leads/hot?days&limit`.
 * Local-dev stub returns a small canned payload so /app's hot-leads
 * card renders without VEX_API_URL.
 */
export async function GET(req: NextRequest): Promise<Response> {
  const upstream = process.env["VEX_API_URL"];
  if (!upstream) return stub(req);
  const sp = req.nextUrl.searchParams;
  const days = sp.get("days") ?? "7";
  const limit = sp.get("limit") ?? "10";
  const url =
    `${upstream.replace(/\/$/, "")}/leads/hot?days=${encodeURIComponent(days)}&limit=${encodeURIComponent(limit)}`;
  try {
    const response = await fetch(url, { headers: buildUpstreamHeaders(req) });
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

function stub(_req: NextRequest): Response {
  return NextResponse.json({
    window_days: 7,
    hot: [
      {
        event_id: "01HSEEDEVT_HOT00000000000A",
        occurred_at: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(),
        lead_id: "01HSEEDLEAD_HOT0000000001",
        lead_stage: "form_fill_submitted",
        contact_id: "01HSEEDCNT_HOT0000000001",
        contact_name: "Jean-Marie Baptiste",
        contact_emails: ["jm@acmeimports.ht"],
        org_id: "01HSEEDORG_HOT0000000001",
        org_name: "acmeimports.ht",
        buying_intent: "intent_to_buy",
        urgency: "immediate",
        product: "rice",
        volume: "500 MT",
        destination: "Port-au-Prince",
        timeline: "Q3 2026",
        summary: "Haitian importer ready to order parboiled rice Q3 2026, LC60D acceptable.",
        source: "website_form",
      },
      {
        event_id: "01HSEEDEVT_HOT00000000000B",
        occurred_at: new Date(Date.now() - 20 * 60 * 60 * 1000).toISOString(),
        lead_id: "01HSEEDLEAD_HOT0000000002",
        lead_stage: "website_chat_ended",
        contact_id: "01HSEEDCNT_HOT0000000002",
        contact_name: "Priya Narine",
        contact_emails: ["priya@massy.tt"],
        org_id: "01HSEEDORG_HOT0000000002",
        org_name: "Massy Energy",
        buying_intent: "intent_to_buy",
        urgency: "near_term",
        product: "ulsd",
        volume: "200kUSG monthly",
        destination: "Point Lisas",
        timeline: "Q2-Q3 2026",
        summary:
          "Trinidad distributor opening a second ULSD supplier; asked for spot + 6-month contract pricing.",
        source: "website_chat",
      },
    ],
  });
}
