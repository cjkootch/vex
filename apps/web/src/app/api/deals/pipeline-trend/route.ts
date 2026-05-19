import { NextResponse, type NextRequest } from "next/server";
import { buildUpstreamHeaders } from "@/lib/upstream-headers";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * GET /api/deals/pipeline-trend — proxy to apps/api
 * `GET /deals/pipeline-trend`. Returns a 14-day series of deal
 * creation counts. Dev stub returns a shaped curve so the sparkline
 * isn't flat when VEX_API_URL is unset.
 */
export async function GET(req: NextRequest): Promise<Response> {
  const upstream = process.env["VEX_API_URL"];
  if (upstream) {
    const url = `${upstream.replace(/\/$/, "")}/deals/pipeline-trend`;
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
  return NextResponse.json({ days: stubDays() });
}

function stubDays(): Array<{ date: string; count: number }> {
  const DAYS = 14;
  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);
  const out: Array<{ date: string; count: number }> = [];
  const shape = [1, 0, 2, 3, 1, 0, 2, 4, 3, 5, 2, 4, 6, 3];
  for (let i = 0; i < DAYS; i++) {
    const d = new Date(today);
    d.setUTCDate(today.getUTCDate() - (DAYS - 1 - i));
    out.push({
      date: d.toISOString().slice(0, 10),
      count: shape[i] ?? 0,
    });
  }
  return out;
}
