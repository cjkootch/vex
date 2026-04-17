import { NextResponse, type NextRequest } from "next/server";
import { buildUpstreamHeaders } from "@/lib/upstream-headers";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * GET /api/search?q=&limit= — proxy to apps/api `GET /search`. Feeds
 * the ⌘K command palette. Local-dev stub returns a small curated set
 * against the seeded IDs so the palette works without a live API.
 */
export async function GET(req: NextRequest): Promise<Response> {
  const upstream = process.env["VEX_API_URL"];
  const incoming = new URL(req.url);
  const q = incoming.searchParams.get("q") ?? "";

  if (upstream) {
    const forwarded = new URLSearchParams();
    for (const key of ["q", "limit"] as const) {
      const value = incoming.searchParams.get(key);
      if (value) forwarded.set(key, value);
    }
    const qs = forwarded.toString();
    const url = `${upstream.replace(/\/$/, "")}/search${qs ? `?${qs}` : ""}`;
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

  return NextResponse.json({ hits: stubHits(q) });
}

function stubHits(q: string) {
  const lowered = q.toLowerCase();
  const all = [
    { kind: "organization" as const, id: "01HSEEDCRP0000000000000001", label: "Acme Corporation", sublabel: "acme.test" },
    { kind: "organization" as const, id: "01HSEEDCRP0000000000000006", label: "Massy Jamaica", sublabel: "massyjm.test" },
    { kind: "contact" as const, id: "01HSEEDCNT0000000000000001", label: "Contact 1", sublabel: "VP Operations" },
    { kind: "deal" as const, id: "01HSEEDDEA0000000000000001", label: "VTC-2026-001", sublabel: "negotiating" },
    { kind: "deal" as const, id: "01HSEEDDEA0000000000000002", label: "VTC-2026-002", sublabel: "approved" },
  ];
  if (lowered.length < 2) return [];
  return all.filter(
    (h) =>
      h.label.toLowerCase().includes(lowered) ||
      (h.sublabel?.toLowerCase().includes(lowered) ?? false),
  );
}
