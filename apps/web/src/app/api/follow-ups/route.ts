import { NextResponse, type NextRequest } from "next/server";
import { buildUpstreamHeaders } from "@/lib/upstream-headers";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(req: NextRequest): Promise<Response> {
  const upstream = process.env["VEX_API_URL"];
  if (upstream) {
    const qs = req.nextUrl.searchParams.toString();
    const url = `${upstream.replace(/\/$/, "")}/follow-ups${qs ? `?${qs}` : ""}`;
    try {
      const res = await fetch(url, { headers: buildUpstreamHeaders(req) });
      const body = await res.text();
      return new Response(body, {
        status: res.status,
        headers: {
          "content-type":
            res.headers.get("content-type") ?? "application/json",
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
  const now = Date.now();
  return NextResponse.json({
    follow_ups: [
      {
        id: "01HSTUBFUPW0000000000000001",
        title: "Follow up with Acme on the Q2 proposal",
        note: "Jane wanted to confirm volume after their board meeting.",
        dueAt: new Date(now + 2 * 86_400_000).toISOString(),
        subjectType: "organization",
        subjectId: "01HSEEDORG0000000000000001",
        assignedTo: null,
        status: "open",
        createdBy: "chat_agent",
        createdAt: new Date(now - 3_600_000).toISOString(),
      },
      {
        id: "01HSTUBFUPW0000000000000002",
        title: "Call Mark Ortiz re: pricing tier",
        note: null,
        dueAt: new Date(now + 6 * 3_600_000).toISOString(),
        subjectType: "contact",
        subjectId: "01HSEEDCNT0000000000000002",
        assignedTo: "cole@vexhq.ai",
        status: "open",
        createdBy: "chat_agent",
        createdAt: new Date(now - 1_200_000).toISOString(),
      },
    ],
  });
}
