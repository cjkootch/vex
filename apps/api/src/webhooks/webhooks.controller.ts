import {
  BadRequestException,
  Controller,
  HttpCode,
  Inject,
  Logger,
  Post,
  Req,
  Res,
} from "@nestjs/common";
import { Throttle } from "@nestjs/throttler";
import type { RawBodyRequest } from "@nestjs/common";
import type { FastifyReply, FastifyRequest } from "fastify";
import { createHash } from "node:crypto";
import type { Queue } from "bullmq";
import { addNormalizationJob, type NormalizationJobData } from "@vex/agents";
import { withTenant, type Db, type RawEventRepository } from "@vex/db";
import type { ResendVerifier } from "./resend-verifier.js";
import type { TwilioVerifier } from "./twilio-verifier.js";
import type { WebsiteChatVerifier } from "./website-chat-verifier.js";
import {
  DB_CLIENT,
  NORMALIZATION_QUEUE,
  RAW_EVENT_REPO,
  RESEND_VERIFIER,
  TWILIO_VERIFIER,
  WEBHOOK_TENANT_RESOLVER,
  WEBSITE_CHAT_VERIFIER,
  type WebhookTenantResolver,
} from "./tokens.js";

@Controller("webhooks")
@Throttle({ webhooks: { limit: 500, ttl: 60_000 } })
export class WebhooksController {
  private readonly log = new Logger(WebhooksController.name);

  constructor(
    @Inject(DB_CLIENT) private readonly db: Db,
    @Inject(RAW_EVENT_REPO) private readonly rawEvents: RawEventRepository,
    @Inject(NORMALIZATION_QUEUE)
    private readonly queue: Queue<NormalizationJobData>,
    @Inject(RESEND_VERIFIER) private readonly resend: ResendVerifier,
    @Inject(TWILIO_VERIFIER) private readonly twilio: TwilioVerifier,
    @Inject(WEBSITE_CHAT_VERIFIER)
    private readonly websiteChat: WebsiteChatVerifier,
    @Inject(WEBHOOK_TENANT_RESOLVER)
    private readonly resolveTenant: WebhookTenantResolver,
  ) {}

  /**
   * POST /webhooks/resend
   *
   * Pipeline (target: <200ms):
   *   1. Read raw body (Nest's `rawBody: true` populates it).
   *   2. Verify Svix HMAC against the raw bytes — never re-stringify.
   *   3. SHA-256 checksum of the raw body.
   *   4. Inside `withTenant(tenantId)`: insertIfNotExists keyed on svix-id.
   *   5. If new, enqueue normalization (jobId = raw_event_id).
   *   6. Return 204.
   */
  @Post("resend")
  @HttpCode(204)
  async resendWebhook(
    @Req() req: RawBodyRequest<FastifyRequest>,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<void> {
    const rawBody = req.rawBody;
    if (!rawBody) {
      throw new BadRequestException("missing_body");
    }

    const verdict = this.resend.verify(req.headers, rawBody);
    if (!verdict.ok) {
      this.log.warn(`resend webhook rejected: ${verdict.reason}`);
      throw new BadRequestException("invalid_signature");
    }

    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(rawBody.toString("utf8")) as Record<string, unknown>;
    } catch {
      throw new BadRequestException("invalid_json");
    }

    const svixId =
      typeof req.headers["svix-id"] === "string"
        ? (req.headers["svix-id"] as string)
        : undefined;
    if (!svixId) throw new BadRequestException("missing_event_id");

    const tenantId = this.resolveTenant("resend", payload);
    const checksum = sha256Hex(rawBody);

    const headersForStorage = pickHeaders(req.headers, [
      "svix-id",
      "svix-timestamp",
      "svix-signature",
      "content-type",
    ]);

    const result = await withTenant(this.db, tenantId, async (tx) =>
      this.rawEvents.insertIfNotExists(
        tx,
        tenantId,
        "resend",
        svixId,
        headersForStorage,
        payload,
        checksum,
      ),
    );

    if (result.isNew) {
      await addNormalizationJob(this.queue, {
        raw_event_id: result.id,
        tenant_id: tenantId,
      });
    }

    void reply;
  }

  /**
   * POST /webhooks/twilio — application/x-www-form-urlencoded.
   */
  @Post("twilio")
  @HttpCode(204)
  async twilioWebhook(
    @Req() req: RawBodyRequest<FastifyRequest>,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<void> {
    const rawBody = req.rawBody;
    if (!rawBody) throw new BadRequestException("missing_body");

    const params = parseFormParams(rawBody);
    const callSid = params["CallSid"];
    const messageSid = params["MessageSid"];
    const providerEventId = callSid ?? messageSid;
    if (!providerEventId) throw new BadRequestException("missing_event_id");

    const fullUrl = reconstructUrl(req);
    const verdict = this.twilio.verify(req.headers, fullUrl, params);
    if (!verdict.ok) {
      this.log.warn(`twilio webhook rejected: ${verdict.reason}`);
      throw new BadRequestException("invalid_signature");
    }

    const tenantId = this.resolveTenant("twilio", params);
    const checksum = sha256Hex(rawBody);

    const headersForStorage = pickHeaders(req.headers, [
      "x-twilio-signature",
      "content-type",
    ]);

    const compositeId = callSid
      ? `${callSid}:${params["CallStatus"] ?? "_"}`
      : providerEventId;

    const result = await withTenant(this.db, tenantId, async (tx) =>
      this.rawEvents.insertIfNotExists(
        tx,
        tenantId,
        "twilio",
        compositeId,
        headersForStorage,
        params,
        checksum,
      ),
    );

    if (result.isNew) {
      await addNormalizationJob(this.queue, {
        raw_event_id: result.id,
        tenant_id: tenantId,
      });
    }

    void reply;
  }

  /**
   * POST /webhooks/website-chat — inbound lead events from the VTC
   * marketing site's AI chat. Two event kinds: `conversation.started`
   * (fires when the gate captures name+email) and `conversation.ended`
   * (fires on idle/unload with the full transcript).
   *
   * Idempotency: the provider_event_id is `<conversation_id>:<event>`
   * so retries of the same event collapse, while started + ended for
   * the same conversation are distinct rows.
   */
  @Post("website-chat")
  @HttpCode(204)
  async websiteChatWebhook(
    @Req() req: RawBodyRequest<FastifyRequest>,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<void> {
    const rawBody = req.rawBody;
    if (!rawBody) throw new BadRequestException("missing_body");

    const verdict = this.websiteChat.verify(req.headers, rawBody);
    if (!verdict.ok) {
      this.log.warn(`website-chat webhook rejected: ${verdict.reason}`);
      throw new BadRequestException("invalid_signature");
    }

    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(rawBody.toString("utf8")) as Record<string, unknown>;
    } catch {
      throw new BadRequestException("invalid_json");
    }

    const conversationId =
      typeof payload["conversation_id"] === "string"
        ? (payload["conversation_id"] as string)
        : undefined;
    const eventKind =
      typeof payload["event"] === "string"
        ? (payload["event"] as string)
        : undefined;
    if (!conversationId || !eventKind) {
      throw new BadRequestException("missing_conversation_or_event");
    }
    if (
      eventKind !== "conversation.started" &&
      eventKind !== "conversation.ended"
    ) {
      throw new BadRequestException("unsupported_event");
    }

    const tenantId = this.resolveTenant("website_chat", payload);
    const checksum = sha256Hex(rawBody);
    const headersForStorage = pickHeaders(req.headers, [
      "x-vtc-timestamp",
      "x-vtc-signature",
      "x-idempotency-key",
      "content-type",
    ]);

    // Composite id keeps `started` and `ended` as distinct rows while
    // retries of the same event collapse via the rawEvents unique
    // constraint on (provider, providerEventId).
    const providerEventId = `${conversationId}:${eventKind}`;

    const result = await withTenant(this.db, tenantId, async (tx) =>
      this.rawEvents.insertIfNotExists(
        tx,
        tenantId,
        "website_chat",
        providerEventId,
        headersForStorage,
        payload,
        checksum,
      ),
    );

    if (result.isNew) {
      await addNormalizationJob(this.queue, {
        raw_event_id: result.id,
        tenant_id: tenantId,
      });
    }

    void reply;
  }

  /**
   * POST /webhooks/email-inbound — provider-agnostic inbound email.
   *
   * Accepts a canonical JSON payload any inbound-email service can POST
   * after a thin translation shim (Resend Inbound, SendGrid Inbound
   * Parse, Postmark Inbound, Mailgun Routes, AWS SES → Lambda). Shape:
   *
   *   { event: "email.received",
   *     from: "<addr>", to: ["<addr>"],
   *     subject?, text?, html?,
   *     message_id: "<RFC5322 Message-ID>",
   *     in_reply_to?: "<Message-ID this replies to>",
   *     received_at?: "<ISO-8601>" }
   *
   * Signed with the same HMAC verifier as /webhooks/website-chat +
   * /webhooks/form — one secret to configure in the email-provider
   * translation shim.
   *
   * Idempotency: provider_event_id = message_id so webhook retries of
   * the same Message-ID collapse at the raw_events layer. The
   * normalizer also uses message_id in its event idempotency key so
   * a replayed raw_event still lands a single event row.
   */
  @Post("email-inbound")
  @HttpCode(204)
  async emailInboundWebhook(
    @Req() req: RawBodyRequest<FastifyRequest>,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<void> {
    const rawBody = req.rawBody;
    if (!rawBody) throw new BadRequestException("missing_body");

    const verdict = this.websiteChat.verify(req.headers, rawBody);
    if (!verdict.ok) {
      this.log.warn(`email-inbound webhook rejected: ${verdict.reason}`);
      throw new BadRequestException("invalid_signature");
    }

    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(rawBody.toString("utf8")) as Record<string, unknown>;
    } catch {
      throw new BadRequestException("invalid_json");
    }

    const eventKind =
      typeof payload["event"] === "string"
        ? (payload["event"] as string)
        : undefined;
    if (eventKind !== "email.received") {
      throw new BadRequestException("unsupported_event");
    }

    const messageId =
      typeof payload["message_id"] === "string"
        ? (payload["message_id"] as string)
        : undefined;
    if (!messageId) {
      throw new BadRequestException("missing_message_id");
    }

    const tenantId = this.resolveTenant("email_inbound", payload);
    const checksum = sha256Hex(rawBody);
    const headersForStorage = pickHeaders(req.headers, [
      "x-vtc-timestamp",
      "x-vtc-signature",
      "x-idempotency-key",
      "content-type",
    ]);

    const result = await withTenant(this.db, tenantId, async (tx) =>
      this.rawEvents.insertIfNotExists(
        tx,
        tenantId,
        "email_inbound",
        messageId,
        headersForStorage,
        payload,
        checksum,
      ),
    );

    if (result.isNew) {
      await addNormalizationJob(this.queue, {
        raw_event_id: result.id,
        tenant_id: tenantId,
      });
    }

    void reply;
  }

  /**
   * POST /webhooks/form — inbound lead events from the VTC marketing
   * site's #lead-form. One event kind today: `form.submitted`. Shares
   * the HMAC signing secret with /webhooks/website-chat since both
   * originate from the same Vercel edge function on the website.
   *
   * Idempotency: provider_event_id is `<form_id>:<email>:<timestamp>`
   * so a webhook retry of the same submission collapses at the
   * raw_events layer. Near-simultaneous double-clicks (same email,
   * distinct timestamps) further dedupe at the events layer via the
   * 5-minute bucketed idempotency key the normalizer emits.
   */
  @Post("form")
  @HttpCode(204)
  async websiteFormWebhook(
    @Req() req: RawBodyRequest<FastifyRequest>,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<void> {
    const rawBody = req.rawBody;
    if (!rawBody) throw new BadRequestException("missing_body");

    const verdict = this.websiteChat.verify(req.headers, rawBody);
    if (!verdict.ok) {
      this.log.warn(`website-form webhook rejected: ${verdict.reason}`);
      throw new BadRequestException("invalid_signature");
    }

    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(rawBody.toString("utf8")) as Record<string, unknown>;
    } catch {
      throw new BadRequestException("invalid_json");
    }

    const eventKind =
      typeof payload["event"] === "string"
        ? (payload["event"] as string)
        : undefined;
    if (eventKind !== "form.submitted") {
      throw new BadRequestException("unsupported_event");
    }

    const formId =
      typeof payload["form_id"] === "string"
        ? (payload["form_id"] as string)
        : undefined;
    const lead = payload["lead"] as Record<string, unknown> | undefined;
    const email =
      lead && typeof lead["email"] === "string"
        ? (lead["email"] as string)
        : undefined;
    const timestamp =
      typeof payload["timestamp"] === "string"
        ? (payload["timestamp"] as string)
        : undefined;
    if (!formId || !email) {
      throw new BadRequestException("missing_form_id_or_email");
    }

    const tenantId = this.resolveTenant("website_form", payload);
    const checksum = sha256Hex(rawBody);
    const headersForStorage = pickHeaders(req.headers, [
      "x-vtc-timestamp",
      "x-vtc-signature",
      "x-idempotency-key",
      "content-type",
    ]);

    // Composite id. A retry of the identical submission (same body →
    // same timestamp) collapses; two genuinely-distinct submissions
    // from the same person land as separate rows.
    const providerEventId = `${formId}:${email}:${timestamp ?? "notime"}`;

    const result = await withTenant(this.db, tenantId, async (tx) =>
      this.rawEvents.insertIfNotExists(
        tx,
        tenantId,
        "website_form",
        providerEventId,
        headersForStorage,
        payload,
        checksum,
      ),
    );

    if (result.isNew) {
      await addNormalizationJob(this.queue, {
        raw_event_id: result.id,
        tenant_id: tenantId,
      });
    }

    void reply;
  }
}

function sha256Hex(buf: Buffer): string {
  return createHash("sha256").update(buf).digest("hex");
}

function pickHeaders(
  source: Record<string, string | string[] | undefined>,
  names: string[],
): Record<string, string> {
  const wanted = new Set(names.map((n) => n.toLowerCase()));
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(source)) {
    if (!wanted.has(k.toLowerCase())) continue;
    if (typeof v === "string") out[k.toLowerCase()] = v;
    else if (Array.isArray(v) && v.length > 0) out[k.toLowerCase()] = v[0]!;
  }
  return out;
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
