import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Header,
  HttpCode,
  Inject,
  Param,
  Post,
  Req,
  UseGuards,
} from "@nestjs/common";
import type { RawBodyRequest } from "@nestjs/common";
import { SkipThrottle } from "@nestjs/throttler";
import type { FastifyRequest } from "fastify";
import { z } from "zod";
import { JwtAuthGuard, RolesGuard, RequireRole, TenantContext } from "../auth/index.js";
import { UserRole } from "@vex/domain";
import type { TwilioVerifier } from "../webhooks/twilio-verifier.js";
import { CallsService } from "./calls.service.js";
import { CALLS_TWILIO_VERIFIER } from "./tokens.js";

const InitiateBody = z.object({
  contact_id: z.string().min(1),
});

/**
 * Outbound-call surface.
 *
 *   POST /calls              — authenticated; starts a workflow
 *   GET  /calls/:workflowId  — authenticated; status
 *   GET  /calls/:workflowId/transcript — authenticated; transcript text + summary
 *
 * Twilio webhooks (unauthenticated but signature-verified):
 *   POST /calls/twilio/twiml        — TwiML driver
 *   POST /calls/twilio/status       — call lifecycle status
 *   POST /calls/twilio/recording    — recording completion
 *
 * `?wf={workflowId}` is appended to the status + recording callback
 * URLs when the workflow creates the Twilio call. The handlers parse
 * that param to route the signal to the right workflow instance.
 */
@Controller("calls")
export class CallsController {
  constructor(
    @Inject(TenantContext) private readonly tenant: TenantContext,
    @Inject(CallsService) private readonly service: CallsService,
    @Inject(CALLS_TWILIO_VERIFIER) private readonly twilioVerifier: TwilioVerifier,
  ) {}

  @Post()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @RequireRole(UserRole.Member)
  async initiate(@Body() raw: unknown) {
    const parsed = InitiateBody.safeParse(raw);
    if (!parsed.success) throw new BadRequestException(parsed.error.message);
    const result = await this.service.initiateCall({
      tenantId: this.tenant.tenantId,
      workspaceId: this.tenant.workspaceId,
      contactId: parsed.data.contact_id,
      initiatedByUserId: this.tenant.userId,
    });
    return {
      workflow_id: result.workflowId,
      approval_id: result.approvalId,
      status: result.status,
    };
  }

  @Get(":workflowId")
  @UseGuards(JwtAuthGuard)
  async status(@Param("workflowId") workflowId: string) {
    return this.service.getStatus(this.tenant.tenantId, workflowId);
  }

  @Get(":workflowId/transcript")
  @UseGuards(JwtAuthGuard)
  async transcript(@Param("workflowId") workflowId: string) {
    return this.service.getTranscript(this.tenant.tenantId, workflowId);
  }

  // -------------------------------------------------------------------
  // Twilio webhook handlers — unauthenticated but signature-verified.
  // -------------------------------------------------------------------

  /**
   * Minimal TwiML driver. Twilio fetches this when the call connects;
   * the response tells Twilio what to say + that it should record.
   * Recording is driven by the `record: true` flag on calls.create
   * plus the recordingStatusCallback URL, not by the TwiML itself.
   *
   * Workflow-aware: the `wf` query param could be used to personalise
   * the opening line per contact; Sprint 12 keeps it generic.
   */
  @Post("twilio/twiml")
  @SkipThrottle()
  @Header("content-type", "text/xml")
  @HttpCode(200)
  async twiml(@Req() req: RawBodyRequest<FastifyRequest>): Promise<string> {
    this.verifyTwilio(req);
    return [
      '<?xml version="1.0" encoding="UTF-8"?>',
      "<Response>",
      "  <Say voice=\"Polly.Joanna\">This is Vex on behalf of Vector Trade Capital. Please hold.</Say>",
      "  <Pause length=\"1\"/>",
      "</Response>",
    ].join("\n");
  }

  @Post("twilio/status")
  @SkipThrottle()
  @HttpCode(204)
  async statusCallback(@Req() req: RawBodyRequest<FastifyRequest>): Promise<void> {
    const { params, workflowId } = this.parseTwilio(req);
    await this.service.handleStatusCallback(workflowId, params);
  }

  @Post("twilio/recording")
  @SkipThrottle()
  @HttpCode(204)
  async recordingCallback(
    @Req() req: RawBodyRequest<FastifyRequest>,
  ): Promise<void> {
    const { params, workflowId, tenantId } = this.parseTwilio(req);
    await this.service.handleRecordingCallback(tenantId, workflowId, params);
  }

  // -------------------------------------------------------------------
  // Internal — signature verification + common Twilio webhook parsing.
  // -------------------------------------------------------------------

  private verifyTwilio(req: RawBodyRequest<FastifyRequest>): Record<string, string> {
    const raw = req.rawBody;
    if (!raw) throw new BadRequestException("missing_body");
    const params = parseFormParams(raw);
    const fullUrl = reconstructUrl(req);
    const verdict = this.twilioVerifier.verify(req.headers, fullUrl, params);
    if (!verdict.ok) {
      throw new BadRequestException(`invalid_signature: ${verdict.reason}`);
    }
    return params;
  }

  private parseTwilio(
    req: RawBodyRequest<FastifyRequest>,
  ): { params: Record<string, string>; workflowId: string; tenantId: string } {
    const params = this.verifyTwilio(req);
    const query = (req.query ?? {}) as Record<string, unknown>;
    const wf = query["wf"];
    if (typeof wf !== "string" || wf.length === 0) {
      throw new BadRequestException("missing_wf_query_param");
    }
    // Workflow id encodes the agentRun; tenant id comes from the
    // caller's JWT for authenticated endpoints, or in this webhook
    // context we read it from the AccountSid → tenant resolver. For
    // Sprint 12 we trust the single-tenant resolver convention the
    // webhooks module already enforces — the caller passes it through
    // query as `tenant` for explicitness.
    const tenantQ = query["tenant"];
    if (typeof tenantQ !== "string" || tenantQ.length === 0) {
      throw new BadRequestException("missing_tenant_query_param");
    }
    return { params, workflowId: wf, tenantId: tenantQ };
  }
}

function parseFormParams(buf: Buffer): Record<string, string> {
  const params = new URLSearchParams(buf.toString("utf8"));
  const out: Record<string, string> = {};
  for (const [k, v] of params.entries()) out[k] = v;
  return out;
}

function reconstructUrl(req: FastifyRequest): string {
  const proto =
    (req.headers["x-forwarded-proto"] as string | undefined) ?? req.protocol ?? "https";
  const host = req.headers["host"] as string | undefined;
  const path = req.raw.url ?? req.url;
  return `${proto}://${host}${path}`;
}
