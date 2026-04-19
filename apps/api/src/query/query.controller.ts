import {
  Body,
  Controller,
  Inject,
  Post,
  Req,
  Res,
  UseGuards,
} from "@nestjs/common";
import { Throttle } from "@nestjs/throttler";
import type { FastifyReply } from "fastify";
import { z } from "zod";
import { createId, TenantId } from "@vex/domain";
import type { AnthropicAdapter } from "@vex/integrations";
import { JwtAuthGuard, TenantContext } from "../auth/index.js";
import { QueryService } from "./query.service.js";
import { ANTHROPIC_ADAPTER } from "./tokens.js";

const HistoryTurn = z.object({
  role: z.enum(["user", "assistant"]),
  text: z.string(),
});

const QueryBody = z.object({
  message: z.string().min(1),
  /**
   * Up to a handful of prior turns from the same chat thread. The
   * service uses them to disambiguate follow-ups ("change this status
   * to won") that reference an entity from the previous answer.
   */
  history: z.array(HistoryTurn).max(20).optional(),
  context: z
    .object({
      org_id: z.string().optional(),
      contact_id: z.string().optional(),
    })
    .optional(),
});
type QueryBody = z.infer<typeof QueryBody>;

const DraftEmailBody = z.object({
  prompt: z.string().min(1).max(2000),
  recipientName: z.string().max(200).optional(),
  tone: z.enum(["friendly", "formal", "concise"]).optional(),
});

@Controller("query")
@UseGuards(JwtAuthGuard)
@Throttle({ query: { limit: 10, ttl: 60_000 } })
export class QueryController {
  constructor(
    @Inject(TenantContext) private readonly tenant: TenantContext,
    @Inject(QueryService) private readonly queries: QueryService,
    @Inject(ANTHROPIC_ADAPTER) private readonly anthropic: AnthropicAdapter,
  ) {}

  /**
   * POST /query — synchronous answer + manifest + cost.
   */
  @Post()
  async query(@Body() raw: unknown) {
    const body = QueryBody.parse(raw) satisfies QueryBody;
    const idempotencyKey = `query:${createId()}`;
    const result = await this.queries.run({
      tenantId: this.tenant.tenantId,
      idempotencyKey,
      message: body.message,
      ...(body.history ? { history: body.history } : {}),
    });
    return {
      answer: result.answer,
      manifest: result.manifest,
      proposed_actions: result.proposedActions,
      evidence_refs: result.evidenceRefs,
      cost_usd: result.costUsd,
      cache_hit: result.cacheHit,
      manifest_valid: result.manifestValid,
    };
  }

  /**
   * POST /query/stream — Server-Sent Events. Sprint 4 ships a buffered
   * pseudo-stream: the full pipeline runs server-side, then the answer is
   * chunked into `event: token` SSE messages and a final `event: manifest`
   * event carries the manifest + actions + cost. Sprint 5 will wire actual
   * Anthropic streaming through the same SSE shape.
   */
  @Post("stream")
  async stream(
    @Body() raw: unknown,
    @Req() req: { id?: string },
    @Res() res: FastifyReply,
  ): Promise<void> {
    const body = QueryBody.parse(raw) satisfies QueryBody;
    const idempotencyKey = `query:${createId()}`;

    res.raw.setHeader("Content-Type", "text/event-stream");
    res.raw.setHeader("Cache-Control", "no-cache, no-transform");
    res.raw.setHeader("Connection", "keep-alive");
    res.raw.setHeader("X-Accel-Buffering", "no");
    res.hijack();

    void req;

    const write = (event: string, data: unknown): void => {
      res.raw.write(`event: ${event}\n`);
      res.raw.write(`data: ${JSON.stringify(data)}\n\n`);
    };

    try {
      const result = await this.queries.run({
        tenantId: this.tenant.tenantId,
        idempotencyKey,
        message: body.message,
      });
      for (const chunk of chunkText(result.answer, 40)) {
        write("token", { text: chunk });
      }
      write("manifest", {
        manifest: result.manifest,
        proposed_actions: result.proposedActions,
        evidence_refs: result.evidenceRefs,
        cost_usd: result.costUsd,
        cache_hit: result.cacheHit,
        manifest_valid: result.manifestValid,
      });
      write("done", { ok: true });
    } catch (err) {
      write("error", { message: (err as Error).message });
    } finally {
      res.raw.end();
    }
  }

  /**
   * POST /query/draft-email — generate a subject + body from a short
   * prompt. Meant for the admin-side compose form as a quick-start;
   * the operator still reviews and edits before sending.
   *
   * Light-weight completion call — no retrieval, no tools. Cost is
   * recorded to the ledger via the adapter's CostEntry path.
   */
  @Post("draft-email")
  @Throttle({ query: { limit: 10, ttl: 60_000 } })
  async draftEmail(@Body() raw: unknown): Promise<{
    subject: string;
    body: string;
  }> {
    const input = DraftEmailBody.parse(raw);
    const toneHint =
      input.tone === "formal"
        ? "Formal business register, no contractions."
        : input.tone === "concise"
          ? "Keep it under 90 words, no filler."
          : "Warm + professional, direct but not stiff.";
    const recipientHint = input.recipientName
      ? `The recipient's name is ${input.recipientName}.`
      : "No recipient name is known; address it generically.";
    const system = `You draft sales/outreach emails for Vector Trade Capital — a commodity trader (fuel + food).

Return ONLY JSON matching this shape, no prose outside the JSON:
{"subject":"<string>", "body":"<string>"}

Constraints:
- ${toneHint}
- ${recipientHint}
- Sign off as "Vex — Vector Trade Capital".
- No placeholders like [Name] or [Company]. Leave fields out if unknown.
- Body is plain text with paragraph breaks. No HTML.`;

    const response = await this.anthropic.complete({
      tenantId: TenantId(this.tenant.tenantId),
      idempotencyKey: `draft-email:${createId()}`,
      system,
      maxTokens: 512,
      messages: [{ role: "user", content: input.prompt }],
    });

    const text = response.content
      .filter((b): b is { type: "text"; text: string } => b.type === "text")
      .map((b) => b.text)
      .join("");

    const parsed = parseDraftJson(text);
    if (!parsed) {
      return {
        subject: "Follow-up",
        body: text.trim() || "Draft generation returned empty.",
      };
    }
    return parsed;
  }
}

function parseDraftJson(
  text: string,
): { subject: string; body: string } | null {
  const jsonStart = text.indexOf("{");
  const jsonEnd = text.lastIndexOf("}");
  if (jsonStart === -1 || jsonEnd === -1 || jsonEnd < jsonStart) return null;
  try {
    const obj = JSON.parse(text.slice(jsonStart, jsonEnd + 1)) as {
      subject?: unknown;
      body?: unknown;
    };
    if (typeof obj.subject !== "string" || typeof obj.body !== "string")
      return null;
    return { subject: obj.subject, body: obj.body };
  } catch {
    return null;
  }
}

function* chunkText(text: string, size: number): Generator<string> {
  for (let i = 0; i < text.length; i += size) {
    yield text.slice(i, i + size);
  }
}
