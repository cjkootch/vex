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

const DemoMessageBody = z.object({
  channel: z.enum(["sms", "whatsapp"]),
  to: z
    .string()
    .regex(/^\+[1-9]\d{7,14}$/, "to must be E.164 (e.g. +18324927169)"),
  body: z.string().min(1).max(1_500),
});

const DemoEmailBody = z.object({
  to: z.string().email("to must be a valid email address"),
  subject: z.string().min(1).max(200),
  body: z.string().min(1).max(5_000),
});

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
  /** Custom AI scenario prompt — overrides the default fuel-qualifier when mode="ai". */
  instructions: z.string().min(1).max(5_000).optional(),
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

  /**
   * Proxy a Twilio call recording through our API so the inbox
   * <audio> tag doesn't prompt the operator for Twilio basic-auth.
   * JWT-protected; the tenant check happens via findById in
   * withTenant so another tenant's recordingSid can't be fetched by
   * guessing an activity id.
   */
  @Get("activities/:id/recording")
  @UseGuards(JwtAuthGuard)
  @Header("content-type", "audio/mpeg")
  async recordingAudio(@Param("id") id: string): Promise<Buffer> {
    return this.service.fetchRecordingAudio(this.tenant.tenantId, id);
  }

  @Get(":workflowId")
  @UseGuards(JwtAuthGuard)
  async status(@Param("workflowId") workflowId: string) {
    return this.service.getStatus(this.tenant.tenantId, workflowId);
  }

  /**
   * Unified debug view for a single call. Consolidates the approval,
   * agent run, voice_call activity, every audit event keyed off the
   * workflow id, and the live Temporal workflow status into one
   * response so an operator can diagnose "my call didn't ring"
   * without ten tool calls.
   */
  @Get(":workflowId/debug")
  @UseGuards(JwtAuthGuard)
  async debug(@Param("workflowId") workflowId: string) {
    return this.service.getDebug(this.tenant.tenantId, workflowId);
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
    const aiMode = query["aiMode"] === "true";
    const workflowId = typeof wf === "string" && wf.length > 0 ? wf : "unknown";

    // Sprint L2 — AI-talkback branch. When the workflow was started
    // with aiMode=true, Vex holds the conversation directly via
    // OpenAI Realtime instead of bridging into a conference. The AI
    // TwiML uses <Connect><Stream> with Parameter children so
    // tenant/wf/instructions reach the bridge (Twilio strips query
    // strings off <Connect><Stream> URLs).
    if (
      aiMode &&
      this.voiceListener.enabled &&
      typeof tenant === "string" &&
      tenant.length > 0
    ) {
      const streamUrl = this.voiceListener.streamUrl.replace(
        "/calls/twilio/stream",
        "/calls/twilio/ai-stream",
      );
      const scenario = await this.service.takeScenario(workflowId);
      const aiLines = [
        '<?xml version="1.0" encoding="UTF-8"?>',
        "<Response>",
        '  <Pause length="1"/>',
        "  <Connect>",
        `    <Stream url="${escapeXml(streamUrl)}">`,
        `      <Parameter name="wf" value="${escapeXml(workflowId)}" />`,
        `      <Parameter name="tenant" value="${escapeXml(tenant)}" />`,
      ];
      if (scenario) {
        aiLines.push(
          `      <Parameter name="instructions" value="${escapeXml(scenario)}" />`,
        );
      }
      aiLines.push("    </Stream>", "  </Connect>", "</Response>");
      return aiLines.join("\n");
    }

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
  /**
   * Admin-only SMS + WhatsApp test send. Bypasses the approval gate +
   * normalizer pipeline. Lands as a touchpoint in the inbox with the
   * `demo_message: true` flag.
   */
  @Post("demo-message")
  @UseGuards(JwtAuthGuard, RolesGuard)
  @RequireRole(UserRole.Admin)
  @HttpCode(202)
  async demoMessage(@Body() raw: unknown) {
    const parsed = DemoMessageBody.safeParse(raw);
    if (!parsed.success) throw new BadRequestException(parsed.error.message);
    return this.service.sendDemoMessage({
      tenantId: this.tenant.tenantId,
      userId: this.tenant.userId,
      channel: parsed.data.channel,
      toNumber: parsed.data.to,
      body: parsed.data.body,
    });
  }

  /**
   * Admin-only email test send via Resend. Same touchpoint-in-inbox
   * pattern as the SMS/WhatsApp demo path.
   */
  @Post("demo-email")
  @UseGuards(JwtAuthGuard, RolesGuard)
  @RequireRole(UserRole.Admin)
  @HttpCode(202)
  async demoEmail(@Body() raw: unknown) {
    const parsed = DemoEmailBody.safeParse(raw);
    if (!parsed.success) throw new BadRequestException(parsed.error.message);
    return this.service.sendDemoEmail({
      tenantId: this.tenant.tenantId,
      userId: this.tenant.userId,
      toAddress: parsed.data.to,
      subject: parsed.data.subject,
      body: parsed.data.body,
    });
  }

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
      instructions?: string;
    } = {
      tenantId: this.tenant.tenantId,
      userId: this.tenant.userId,
      toNumber: parsed.data.phone,
      mode: parsed.data.mode,
    };
    if (parsed.data.script !== undefined) args.script = parsed.data.script;
    if (parsed.data.instructions !== undefined) {
      args.instructions = parsed.data.instructions;
    }
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
    // Twilio's `<Connect><Stream>` strips URL query strings before
    // opening the WebSocket. Pass params as `<Parameter>` children so
    // they arrive in the stream's "start" event as customParameters.
    const streamUrl = this.voiceListener.streamUrl.replace(
      "/calls/twilio/stream",
      "/calls/twilio/ai-stream",
    );
    const scenario = await this.service.takeScenario(wf);
    const lines = [
      '<?xml version="1.0" encoding="UTF-8"?>',
      "<Response>",
      // Short pause so the callee has a moment after pick-up before
      // the AI starts speaking.
      '  <Pause length="1"/>',
      "  <Connect>",
      `    <Stream url="${escapeXml(streamUrl)}">`,
      `      <Parameter name="wf" value="${escapeXml(wf)}" />`,
      `      <Parameter name="tenant" value="${escapeXml(tenant)}" />`,
    ];
    if (scenario) {
      lines.push(
        `      <Parameter name="instructions" value="${escapeXml(scenario)}" />`,
      );
    }
    lines.push("    </Stream>", "  </Connect>", "</Response>");
    return lines.join("\n");
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
    const { params, workflowId, tenantId } = this.parseTwilio(req);
    await this.service.handleStatusCallback(workflowId, params, tenantId);
  }

  /**
   * Demo-call status callback. Unauthenticated (Twilio signs webhooks
   * with AccountSid-level auth, not per-request; we skip verification
   * here because the payload only updates a row keyed by CallSid).
   * Twilio posts form-urlencoded CallSid + CallStatus + CallDuration
   * + From/To; we mirror those into the matching voice_call activity.
   */
  @Post("twilio/demo-status")
  @SkipThrottle()
  @HttpCode(204)
  async demoStatusCallback(
    @Req() req: RawBodyRequest<FastifyRequest>,
  ): Promise<void> {
    const params = req.rawBody ? parseFormParams(req.rawBody) : {};
    const query = (req.query ?? {}) as Record<string, unknown>;
    const tenant =
      typeof query["tenant"] === "string" ? (query["tenant"] as string) : "";
    // eslint-disable-next-line no-console
    console.log(
      `demo-status in: rawBody=${req.rawBody ? req.rawBody.length : "null"} tenant=${tenant || "MISSING"} callSid=${params["CallSid"] ?? "MISSING"} status=${params["CallStatus"] ?? "MISSING"}`,
    );
    if (!tenant) return;
    await this.service.handleDemoStatus(tenant, params);
  }

  /**
   * Demo-call recording callback. Twilio fires this once the recording
   * is ready with RecordingSid + RecordingUrl + RecordingDuration. We
   * attach those to the matching voice_call activity so the drill-in
   * can render a playable link.
   */
  @Post("twilio/demo-recording")
  @SkipThrottle()
  @HttpCode(204)
  async demoRecordingCallback(
    @Req() req: RawBodyRequest<FastifyRequest>,
  ): Promise<void> {
    const params = req.rawBody ? parseFormParams(req.rawBody) : {};
    const query = (req.query ?? {}) as Record<string, unknown>;
    const tenant =
      typeof query["tenant"] === "string" ? (query["tenant"] as string) : "";
    if (!tenant) return;
    await this.service.handleDemoRecording(tenant, params);
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
