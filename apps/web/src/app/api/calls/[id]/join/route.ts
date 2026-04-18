import { NextResponse, type NextRequest } from "next/server";
import { buildUpstreamHeaders } from "@/lib/upstream-headers";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * POST /api/calls/:id/join — Sprint J. Proxies to apps/api
 * `POST /calls/:workflowId/join`. Returns the Twilio Voice SDK
 * Access Token the operator's browser uses to connect as a
 * conference participant (live-listen + takeover).
 *
 * Response: { token, identity, conferenceName, expiresAt }.
 *
 * When the upstream is unreachable or the Voice SDK env vars aren't
 * configured, the response carries the upstream's error body through
 * verbatim so the UI can surface a specific message ("Voice SDK not
 * configured" vs "Call already ended").
 */
export async function POST(
  req: NextRequest,
  { params }: { params: { id: string } },
): Promise<Response> {
  const upstream = process.env["VEX_API_URL"];
  if (upstream) {
    const url = `${upstream.replace(/\/$/, "")}/calls/${encodeURIComponent(params.id)}/join`;
    try {
      const headers = buildUpstreamHeaders(req);
      headers.set("content-type", "application/json");
      const response = await fetch(url, {
        method: "POST",
        headers,
        body: "{}",
      });
      const text = await response.text();
      return new Response(text, {
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

  // Local-dev stub — no real token. The detail page falls back to a
  // "live-listen unavailable in dev without VEX_API_URL" banner when
  // the token string is empty, so this doesn't try to boot the SDK.
  return NextResponse.json(
    {
      token: "",
      identity: "operator-dev",
      conferenceName: `vex-${params.id}`,
      expiresAt: new Date(Date.now() + 3600_000).toISOString(),
    },
    { status: 200 },
  );
}
