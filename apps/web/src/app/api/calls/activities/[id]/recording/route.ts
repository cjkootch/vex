import { NextResponse, type NextRequest } from "next/server";
import { buildUpstreamHeaders } from "@/lib/upstream-headers";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * GET /api/calls/activities/:id/recording — Next proxy that streams
 * the Twilio recording audio from our API. The API endpoint uses its
 * stored Twilio creds to do the basic-auth fetch, so the browser
 * never sees a Twilio auth prompt.
 */
export async function GET(
  req: NextRequest,
  ctx: { params: { id: string } },
): Promise<Response> {
  const upstream = process.env["VEX_API_URL"];
  if (!upstream) {
    return NextResponse.json({ error: "upstream_unavailable" }, { status: 502 });
  }
  const url = `${upstream.replace(/\/$/, "")}/calls/activities/${encodeURIComponent(ctx.params.id)}/recording`;
  try {
    const response = await fetch(url, { headers: buildUpstreamHeaders(req) });
    // Stream the body back with the audio content-type. Don't buffer —
    // the raw Fetch API ReadableStream passes straight through.
    return new Response(response.body, {
      status: response.status,
      headers: {
        "content-type":
          response.headers.get("content-type") ?? "audio/mpeg",
        ...(response.headers.get("content-length")
          ? {
              "content-length": response.headers.get("content-length")!,
            }
          : {}),
      },
    });
  } catch (err) {
    return NextResponse.json(
      { error: "upstream_unavailable", message: (err as Error).message },
      { status: 502 },
    );
  }
}
