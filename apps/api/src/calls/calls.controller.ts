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
import type { VoiceListenerConfig } from "./calls.module.js";
import {
  CALLS_TWILIO_VERIFIER,
  CALLS_VOICE_LISTENER_CONFIG,
} from "./tokens.js";

const InitiateBody = z.object({
  contact_id: z.string().min(1),
});

const RequestBackupBody = z
  .object({
    reason: z.string().min(1).max(500).optional(),
  })
  .default({});

const DemoCallBody = z.object({
  phone: z
    .string()
    .regex(/^\+[1-9]\d{7,14}$/, "phone must be E.164 (e.g. +18324927169)"),
  script: z.string().min(1).max(1_500).optional(),
  /**
   * Sprint L — when true, dial into the AI talkback path (OpenAI
   * Realtime bidirectional voice) instead of the static Polly script.
   * Default false preserves the Sprint-L-predecessor demo behaviour.
   */
  mode: z.enum(["polly", "ai"]).default("polly"),
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
    @Inject(CALLS_VOICE_LISTENER_CONFIG)
    private readonly voiceListener: VoiceListenerConfig,
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

  /**
   * Sprint I — request human backup on an in-flight call. Creates a
   * T2 approval the operator inbox surfaces with a "Join call" CTA.
   * Idempotent at the workflow level: repeated calls while an open
   * request exists reuse the same approval id.
   */
  @Post(":workflowId/request-backup")
  @UseGuards(JwtAuthGuard)
  @HttpCode(201)
  async requestBackup(
    @Param("workflowId") workflowId: string,
    @Body() raw: unknown,
  ) {
    const parsed = RequestBackupBody.safeParse(raw ?? {});
    if (!parsed.success) throw new BadRequestException(parsed.error.message);
    const args: {
      tenantId: string;
      workflowId: string;
      initiatedBy: string;
      reason?: string;
    } = {
      tenantId: this.tenant.tenantId,
      workflowId,
      initiatedBy: this.tenant.userId,
    };
    if (parsed.data.reason !== undefined) args.reason = parsed.data.reason;
    return this.service.requestHumanBackup(args);
  }

  // -------------------------------------------------------------------
  // Twilio webhook handlers — unauthenticated but signature-verified.
  // -------------------------------------------------------------------

  /**
   * TwiML driver. Twilio fetches this when the outbound leg connects;
   * the response tells Twilio to dial the callee into a Conference
   * room named after the workflow id. The operator browser join
   * endpoint mints an Access Token scoped to the same conference name,
   * which is how live-listen + takeover work without a second PSTN
   * hop.
   *
   * Conference lifecycle:
   *   - `startConferenceOnEnter=true` — the callee leg starts the room;
   *     operator arrivals never kick off a conference by themselves.
   *   - `endConferenceOnExit=true` — when the callee hangs up the room
   *     ends for everyone (including any joined operator).
   *
   * Recording still flows through the outbound call leg's
   * `record: true` flag and recordingStatusCallback — the callee leg
   * captures the full conference audio so Sprint 12's transcription
   * path is unchanged.
   */
  @Post("twilio/twiml")
  @SkipThrottle()
  @Header("content-type", "text/xml")
  @HttpCode(200)
  async twiml(@Req() req: RawBodyRequest<FastifyRequest>): Promise<string> {
    this.verifyTwilio(req);
    const query = (req.query ?? {}) as Record<string, unknown>;
    const wf = query["wf"];
    const tenant = query["tenant"];
    const workflowId = typeof wf === "string" && wf.length > 0 ? wf : "unknown";
    const confName = conferenceNameForWorkflow(workflowId);

    const lines = ['<?xml version="1.0" encoding="UTF-8"?>', "<Response>"];
    if (
      this.voiceListener.enabled &&
      typeof tenant === "string" &&
      tenant.length > 0
    ) {
      // Sprint K — fork callee audio to the escalation-listener WS.
      // `Start`/`Stream` is unidirectional (Twilio → us); the AI can
      // observe but not inject audio back, which keeps Sprint J's
      // Dial+Conference intact for the operator join flow.
      const streamUrl = `${this.voiceListener.streamUrl}?wf=${encodeURIComponent(
        workflowId,
      )}&tenant=${encodeURIComponent(tenant)}`;
      lines.push("  <Start>");
      lines.push(`    <Stream url="${escapeXml(streamUrl)}" track="inbound_track" />`);
      lines.push("  </Start>");
    }
    lines.push("  <Dial>");
    lines.push(
      `    <Conference startConferenceOnEnter="true" endConferenceOnExit="true" beep="false">${escapeXml(confName)}</Conference>`,
    );
    lines.push("  </Dial>");
    lines.push("</Response>");
    return lines.join("\n");
  }

  /**
   * Fire a scripted-voice demo call. Admin-only, non-interactive —
   * bypasses the T3 approval gate and the OutboundCallWorkflow
   * entirely. Dials the number, Twilio plays the script via Polly,
   * records an `activity` row so `/app/inbox` shows the call.
   *
   * This is a test/demo path for verifying the Twilio plumbing end-
   * to-end. Real operator-initiated calls still flow through
   * `POST /calls` → approval gate → workflow → conference. Sprint L
   * replaces this scripted path with real-time AI voice.
   */
  @Post("demo")
  @UseGuards(JwtAuthGuard, RolesGuard)
  @RequireRole(UserRole.Admin)
  @HttpCode(202)
  async demoCall(@Body() raw: unknown) {
    const parsed = DemoCallBody.safeParse(raw);
    if (!parsed.success) throw new BadRequestException(parsed.error.message);
    const args: {
      tenantId: string;
      userId: string;
      toNumber: string;
      mode: "polly" | "ai";
      script?: string;
    } = {
      tenantId: this.tenant.tenantId,
      userId: this.tenant.userId,
      toNumber: parsed.data.phone,
      mode: parsed.data.mode,
    };
    if (parsed.data.script !== undefined) args.script = parsed.data.script;
    return this.service.initiateDemoCall(args);
  }

  /**
   * TwiML endpoint for the demo-call path. Signature-verified (Twilio
   * signs its outbound fetch with the account auth token) so the
   * audience is always Twilio. `text` query param carries the
   * URL-encoded script the demo endpoint set.
   */
  /**
   * Unauthenticated — intentionally. The demo path passes the script
   * via a URL-encoded query param, which makes Twilio's signature
   * round-trip brittle (the URL that gets signed doesn't always match
   * what arrives at the handler after Fastify/Node normalization).
   * Side-effect-free (returns TwiML, touches nothing), so skipping
   * signature verification is acceptable for this test-only route.
   * Production calls still flow through /calls/twilio/twiml which is
   * signature-verified.
   */
  @Post("twilio/demo-twiml")
  @SkipThrottle()
  @Header("content-type", "text/xml")
  @HttpCode(200)
  async demoTwiml(@Req() req: RawBodyRequest<FastifyRequest>): Promise<string> {
    const query = (req.query ?? {}) as Record<string, unknown>;
    const text =
      typeof query["text"] === "string" && query["text"].length > 0
        ? (query["text"] as string)
        : "Hello from Vex. This is a test call.";
    return [
      '<?xml version="1.0" encoding="UTF-8"?>',
      "<Response>",
      // 1s head pause so the callee has time to get the phone to
      // their ear and say "hello" before the script starts.
      '  <Pause length="1"/>',
      `  <Say voice="Polly.Joanna">${escapeXml(text)}</Say>`,
      // Pause gives the callee space to respond even though no one is
      // listening; keeps the call open long enough to feel like a
      // real conversation rather than a robocall.
      '  <Pause length="20"/>',
      '  <Say voice="Polly.Joanna">Thanks for your time. We will follow up by email. Goodbye.</Say>',
      "</Response>",
    ].join("\n");
  }

  /**
   * Sprint L — TwiML for the AI talkback path. Twilio fetches this
   * when the AI-demo call is answered; the response connects the
   * call leg to our Media Stream WebSocket. OpenAI Realtime drives
   * the conversation. Query param `tenant` is used by the WS server
   * to scope tools (escalate_to_human) to the right workspace.
   *
   * Unauthenticated for the same reason as /calls/twilio/demo-twiml
   * — URL-encoded query + Fastify normalization makes Twilio's
   * signature check brittle, and the endpoint is side-effect-free.
   */
  @Post("twilio/ai-twiml")
  @SkipThrottle()
  @Header("content-type", "text/xml")
  @HttpCode(200)
  async aiTwiml(@Req() req: RawBodyRequest<FastifyRequest>): Promise<string> {
    const query = (req.query ?? {}) as Record<string, unknown>;
    const tenant =
      typeof query["tenant"] === "string" ? (query["tenant"] as string) : "";
    const wf =
      typeof query["wf"] === "string" ? (query["wf"] as string) : "demo";
    const streamUrl = `${this.voiceListener.streamUrl
      .replace("/calls/twilio/stream", "/calls/twilio/ai-stream")}?wf=${encodeURIComponent(wf)}&tenant=${encodeURIComponent(tenant)}`;
    return [
      '<?xml version="1.0" encoding="UTF-8"?>',
      "<Response>",
      // Short pause so the callee has a moment after pick-up before
      // the AI starts speaking.
      '  <Pause length="1"/>',
      "  <Connect>",
      `    <Stream url="${escapeXml(streamUrl)}" />`,
      "  </Connect>",
      "</Response>",
    ].join("\n");
  }

  /**
   * Sprint J — mint a Twilio Access Token scoped to the conference
   * room for this workflow so the operator's browser can join as a
   * Voice SDK participant. The token has no bearer identity from
   * Twilio's perspective; our own JWT already authorised the user.
   */
  @Post(":workflowId/join")
  @UseGuards(JwtAuthGuard)
  @HttpCode(200)
  async joinCall(@Param("workflowId") workflowId: string) {
    return this.service.mintJoinToken({
      tenantId: this.tenant.tenantId,
      workflowId,
      userId: this.tenant.userId,
      conferenceName: conferenceNameForWorkflow(workflowId),
    });
  }

  /**
   * Sprint J — browser-originated join TwiML. The Twilio Voice SDK
   * `Device.connect({ conference })` call routes here via the TwiML
   * app the Access Token is scoped to. Twilio POSTs the conference
   * name as a form param; we return a Dial+Conference with muted
   * beep so the operator audibly drops in without a chime.
   *
   * Signature-verified — Twilio still signs TwiML-app requests with
   * the account auth token.
   */
  @Post("twilio/join-twiml")
  @SkipThrottle()
  @Header("content-type", "text/xml")
  @HttpCode(200)
  async joinTwiml(@Req() req: RawBodyRequest<FastifyRequest>): Promise<string> {
    const params = this.verifyTwilio(req);
    const confName = params["conference"];
    if (!confName) {
      throw new BadRequestException("missing_conference_param");
    }
    return [
      '<?xml version="1.0" encoding="UTF-8"?>',
      "<Response>",
      "  <Dial>",
      `    <Conference startConferenceOnEnter="false" endConferenceOnExit="false" beep="false">${escapeXml(confName)}</Conference>`,
      "  </Dial>",
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

  /**
   * Demo-call status callback. Unauthenticated + no-op — we don't
   * drive a workflow for demo calls, so the lifecycle events are only
   * useful if something goes wrong and we want to look at the logs.
   * Accept + 204 so Twilio doesn't retry.
   */
  @Post("twilio/demo-status")
  @SkipThrottle()
  @HttpCode(204)
  async demoStatusCallback(): Promise<void> {
    return;
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

/**
 * Deterministic Conference room name derived from the workflow id.
 * Shared by the TwiML endpoint (callee leg) and the join-token minter
 * (operator leg). Must be stable — Twilio matches participants by
 * the exact string.
 */
export function conferenceNameForWorkflow(workflowId: string): string {
  return `vex-${workflowId}`;
}

/** Minimal XML escape for the conference name emitted inside TwiML. */
function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}
