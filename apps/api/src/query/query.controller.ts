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
import { createId } from "@vex/domain";
import { JwtAuthGuard, TenantContext } from "../auth/index.js";
import { QueryService } from "./query.service.js";

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
  /**
   * Sprint T — subject-scoped chat. Set when the operator opens
   * chat from a contact/deal/organization/campaign page (the Ask Vex
   * button deep-links `?scope=type:id`) or when the floating widget
   * is open on a subject page. The retrieval layer pins the subject
   * in the evidence pack so every answer in the session is biased
   * toward it.
   */
  scope: z
    .object({
      type: z.enum(["contact", "deal", "organization", "campaign"]),
      id: z.string().min(1).max(40),
    })
    .optional(),
});
type QueryBody = z.infer<typeof QueryBody>;

@Controller("query")
@UseGuards(JwtAuthGuard)
@Throttle({ query: { limit: 10, ttl: 60_000 } })
export class QueryController {
  constructor(
    @Inject(TenantContext) private readonly tenant: TenantContext,
    @Inject(QueryService) private readonly queries: QueryService,
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
      ...(body.scope ? { scope: body.scope } : {}),
    });
    return {
      answer: result.answer,
      manifest: result.manifest,
      proposed_actions: result.proposedActions,
      created_approvals: result.createdApprovals,
      rejected_proposals: result.rejectedProposals,
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
        ...(body.history ? { history: body.history } : {}),
        ...(body.scope ? { scope: body.scope } : {}),
        onToolUse: (name) => write("tool_start", { tool: name }),
        onToolDone: (name, ok) => write("tool_end", { tool: name, ok }),
      });
      for (const chunk of chunkText(result.answer, 40)) {
        write("token", { text: chunk });
      }
      write("manifest", {
        manifest: result.manifest,
        proposed_actions: result.proposedActions,
        created_approvals: result.createdApprovals,
        rejected_proposals: result.rejectedProposals,
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
}

function* chunkText(text: string, size: number): Generator<string> {
  for (let i = 0; i < text.length; i += size) {
    yield text.slice(i, i + size);
  }
}
