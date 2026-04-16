import { NextResponse, type NextRequest } from "next/server";
import { buildUpstreamHeaders } from "@/lib/upstream-headers";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * Sprint-5 stub. The real `POST /query/stream` lives in `apps/api` (NestJS)
 * and isn't deployed yet. This route lets the Sprint-5 UI stream against
 * canned responses for local dev and Playwright. When `process.env.VEX_API_URL`
 * is set, requests are proxied to the real API instead.
 *
 * Two test hooks (header-driven so Playwright can flip them):
 *   - `x-vex-test-malformed: 1` returns a manifest with an invalid panel
 *     so the ManifestValidator fallback path can be exercised.
 *   - `x-vex-test-throwing: 1` returns a panel whose props will trip the
 *     PanelErrorBoundary in `TablePanel` (rows = null).
 */
export async function POST(req: NextRequest): Promise<Response> {
  const upstream = process.env["VEX_API_URL"];
  if (upstream) {
    return proxy(upstream, req);
  }

  const body = (await req.json().catch(() => ({}))) as { message?: string };
  const message = body.message ?? "";
  const malformed = req.headers.get("x-vex-test-malformed") === "1";
  const throwing = req.headers.get("x-vex-test-throwing") === "1";

  return new Response(
    new ReadableStream({
      async start(controller) {
        const encoder = new TextEncoder();
        const write = (event: string, data: unknown): void => {
          controller.enqueue(encoder.encode(`event: ${event}\n`));
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`));
        };

        const answer = stubAnswer(message);
        for (const chunk of chunkText(answer, 30)) {
          write("token", { text: chunk });
          await sleep(30);
        }

        write("manifest", buildManifest({ malformed, throwing }));
        write("done", { ok: true });
        controller.close();
      },
    }),
    {
      headers: {
        "content-type": "text/event-stream",
        "cache-control": "no-cache, no-transform",
        connection: "keep-alive",
      },
    },
  );
}

async function proxy(upstreamBase: string, req: NextRequest): Promise<Response> {
  const url = new URL("/query/stream", upstreamBase).toString();
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: buildUpstreamHeaders(req),
      body: req.body,
      // @ts-expect-error — duplex required for streaming POST in Node fetch
      duplex: "half",
    });
    return new Response(response.body, {
      status: response.status,
      headers: sanitizeResponseHeaders(response.headers),
    });
  } catch (err) {
    return NextResponse.json(
      { error: "upstream_unavailable", message: (err as Error).message },
      { status: 502 },
    );
  }
}

/**
 * Node fetch auto-decompresses upstream responses, but the upstream
 * headers still say `content-encoding: gzip` + the original compressed
 * `content-length`. Forwarding those to the browser triggers
 * ERR_CONTENT_DECODING_FAILED. Strip both so the browser reads the body
 * as raw bytes.
 */
function sanitizeResponseHeaders(src: Headers): Headers {
  const out = new Headers(src);
  out.delete("content-encoding");
  out.delete("content-length");
  out.delete("transfer-encoding");
  return out;
}

function stubAnswer(message: string): string {
  if (!message) return "Ask Vex a question to see the canvas in action.";
  return `Stub response for: "${message}". Sprint 5 ships the canvas. Sprint 6 wires the model.`;
}

function buildManifest({
  malformed,
  throwing,
}: {
  malformed: boolean;
  throwing: boolean;
}): Record<string, unknown> {
  if (malformed) {
    return {
      manifest: { panels: [{ type: "iframe", src: "evil" }] },
      evidence_refs: ["01HSEEDCRP0000000000000001"],
      cost_usd: 0,
      cache_hit: false,
      manifest_valid: false,
    };
  }

  const panels: unknown[] = [
    {
      type: "profile",
      objectType: "organization",
      objectId: "01HSEEDCRP0000000000000001",
      fields: { Name: "Acme Corporation", Industry: "Manufacturing", "Fit score": "0.91" },
    },
    {
      type: "kpi_rail",
      metrics: [
        { label: "ARR", value: "$120k", trend: "up", delta: "+12%" },
        { label: "Open Opportunities", value: "3" },
        { label: "Last touch", value: "3 days ago" },
      ],
    },
    {
      type: "evidence",
      items: [
        {
          chunk_id: "01HSEEDSMR0000000000000001",
          source_ref: "summary v1 / Acme Corporation",
          occurred_at: new Date().toISOString(),
          freshness_hours: 4,
          confidence_score: 0.91,
        },
        {
          chunk_id: "01HSEEDTCH0000000000000001",
          source_ref: "weak / email.opened touchpoint",
          occurred_at: new Date(Date.now() - 36 * 3600 * 1000).toISOString(),
          freshness_hours: 36,
          confidence_score: 0.4,
        },
      ],
    },
  ];

  if (throwing) {
    // Force a render-time crash so PanelErrorBoundary can be observed.
    panels.push({
      type: "table",
      title: "Will throw",
      columns: ["A"],
      rows: null,
    });
    panels.push({
      type: "kpi_rail",
      metrics: [{ label: "Sibling", value: "still renders" }],
    });
  }

  return {
    manifest: { panels },
    evidence_refs: [
      "01HSEEDSMR0000000000000001",
      "01HSEEDTCH0000000000000001",
    ],
    cost_usd: 0.0042,
    cache_hit: true,
    manifest_valid: true,
  };
}

function* chunkText(text: string, size: number): Generator<string> {
  for (let i = 0; i < text.length; i += size) yield text.slice(i, i + size);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
