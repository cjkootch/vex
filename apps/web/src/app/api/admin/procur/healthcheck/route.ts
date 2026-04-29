import { NextResponse, type NextRequest } from "next/server";
import { buildUpstreamHeaders } from "@/lib/upstream-headers";

/**
 * Proxy for the procur healthcheck. Forwards the session cookie from
 * the web app (where the operator is logged in) to vex-api so the
 * OWNER-only endpoint accepts the request. Lets operators hit the
 * diagnostic from a browser tab without juggling session cookies
 * across origins.
 *
 * Pass through any query params verbatim (?supplier=&country=&days=).
 */

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(req: NextRequest): Promise<Response> {
  const upstream = process.env["VEX_API_URL"];
  if (!upstream) {
    return NextResponse.json(
      { error: "vex_api_url_unset" },
      { status: 503 },
    );
  }
  const search = req.nextUrl.search;
  const url = `${upstream.replace(/\/$/, "")}/admin/procur/healthcheck${search}`;
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
