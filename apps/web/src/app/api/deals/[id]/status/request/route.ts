import { NextResponse, type NextRequest } from "next/server";
import { buildUpstreamHeaders } from "@/lib/upstream-headers";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * POST /api/deals/:id/status/request — proxy to apps/api
 * `POST /deals/:id/status/request`. Creates a T2 approval row for
 * promoting a deal to `approved` or moving it to `cancelled`. The
 * approved approval is applied by the worker's executor.
 */
export async function POST(
  req: NextRequest,
  { params }: { params: { id: string } },
): Promise<Response> {
  const upstream = process.env["VEX_API_URL"];
  const bodyText = await req.text();

  if (upstream) {
    const url = `${upstream.replace(/\/$/, "")}/deals/${encodeURIComponent(params.id)}/status/request`;
    try {
      const headers = buildUpstreamHeaders(req);
      headers.set("content-type", "application/json");
      const response = await fetch(url, {
        method: "POST",
        headers,
        body: bodyText,
      });
      const responseBody = await response.text();
      return new Response(responseBody, {
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

  // Local-dev stub — synthesise an approval id so the UI shows the
  // toast + link flow end-to-end.
  const suffix = Date.now().toString(36).slice(-6);
  return NextResponse.json(
    {
      approvalId: `01HAPP0000000000000000${suffix}`.padEnd(26, "0").slice(0, 26),
      status: "pending",
      stub: true,
    },
    { status: 201 },
  );
}
