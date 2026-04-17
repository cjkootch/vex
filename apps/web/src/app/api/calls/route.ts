import { NextResponse, type NextRequest } from "next/server";
import { buildUpstreamHeaders } from "@/lib/upstream-headers";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * POST /api/calls — proxy to apps/api `POST /calls`. Initiates an
 * outbound-call workflow (Sprint 12).
 *
 * Request body: { contact_id: string }
 * Response: { workflow_id, approval_id, status }
 *
 * When VEX_API_URL is unset the route returns a local-dev stub so the
 * /app/calls page is interactive without a running apps/api. The stub
 * synthesises a plausible workflow + approval id so subsequent
 * GET /api/calls/:id calls can match.
 */
export async function POST(req: NextRequest): Promise<Response> {
  const upstream = process.env["VEX_API_URL"];
  const bodyText = await req.text();
  if (upstream) {
    const url = `${upstream.replace(/\/$/, "")}/calls`;
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

  // Local-dev stub
  let contactId = "stub-contact";
  try {
    const parsed = JSON.parse(bodyText) as { contact_id?: string };
    if (parsed.contact_id) contactId = parsed.contact_id;
  } catch {
    /* ignore — keep stub contact id */
  }
  const suffix = Date.now().toString(36).slice(-6);
  return NextResponse.json({
    workflow_id: `outbound-call-stub-${suffix}`,
    approval_id: `stub-approval-${suffix}`,
    status: "pending_approval",
    stub: true,
    contact_id: contactId,
  });
}
