import { NextResponse, type NextRequest } from "next/server";
import { buildUpstreamHeaders } from "@/lib/upstream-headers";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * POST /api/query/draft-email — proxy to apps/api
 * `POST /query/draft-email`. When VEX_API_URL is unset, returns a
 * canned draft so the admin compose form is still exercisable in
 * local dev.
 */
export async function POST(req: NextRequest): Promise<Response> {
  const upstream = process.env["VEX_API_URL"];
  if (upstream) {
    const url = `${upstream.replace(/\/$/, "")}/query/draft-email`;
    try {
      const response = await fetch(url, {
        method: "POST",
        headers: {
          ...buildUpstreamHeaders(req),
          "content-type": "application/json",
        },
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

  const body = (await req.json().catch(() => ({}))) as {
    prompt?: string;
    recipientName?: string;
  };
  const prompt = body.prompt?.trim() ?? "";
  return NextResponse.json({
    subject: "Follow-up from Vector Trade Capital",
    body: `Hi${body.recipientName ? ` ${body.recipientName}` : ""},

Quick note from Vector Trade Capital — ${prompt || "wanted to follow up on our earlier thread"}. Happy to jump on a call whenever it's convenient.

Best,
Vex — Vector Trade Capital`,
  });
}
