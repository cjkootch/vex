import { NextResponse, type NextRequest } from "next/server";
import { buildUpstreamHeaders } from "@/lib/upstream-headers";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * GET /api/documents?subject_type=X&subject_id=Y — list documents
 * attached to a subject. Forwards to apps/api.
 */
export async function GET(req: NextRequest): Promise<Response> {
  const upstream = process.env["VEX_API_URL"];
  if (!upstream) return NextResponse.json({ documents: [] });
  const qs = req.nextUrl.searchParams.toString();
  const url = `${upstream.replace(/\/$/, "")}/documents${qs ? `?${qs}` : ""}`;
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

/**
 * POST /api/documents — multipart upload proxy. Streams the
 * client's multipart body straight through to apps/api which
 * handles the S3 put and the documents-table insert.
 */
export async function POST(req: NextRequest): Promise<Response> {
  const upstream = process.env["VEX_API_URL"];
  if (!upstream) {
    return NextResponse.json(
      { error: "upstream_unavailable" },
      { status: 502 },
    );
  }
  const url = `${upstream.replace(/\/$/, "")}/documents`;
  try {
    const headers = buildUpstreamHeaders(req);
    const ct = req.headers.get("content-type");
    if (ct) headers.set("content-type", ct);
    const response = await fetch(url, {
      method: "POST",
      headers,
      body: req.body,
      // @ts-expect-error Node fetch requires duplex: "half" for streaming bodies
      duplex: "half",
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
