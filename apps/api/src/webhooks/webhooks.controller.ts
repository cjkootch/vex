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
import type { RawBodyRequest } from "@nestjs/common";
import type { FastifyReply, FastifyRequest } from "fastify";
import { createHash } from "node:crypto";
import type { Queue } from "bullmq";
import { addNormalizationJob, type NormalizationJobData } from "@vex/agents";
import type { RawEventRepository } from "@vex/db";
import type { ResendVerifier } from "./resend-verifier.js";
import type { TwilioVerifier } from "./twilio-verifier.js";
import {
  NORMALIZATION_QUEUE,
  RAW_EVENT_REPO,
  RESEND_VERIFIER,
  TWILIO_VERIFIER,
  WEBHOOK_TENANT_RESOLVER,
  type WebhookTenantResolver,
} from "./tokens.js";

@Controller("webhooks")
export class WebhooksController {
  private readonly log = new Logger(WebhooksController.name);

  constructor(
    @Inject(RAW_EVENT_REPO) private readonly rawEvents: RawEventRepository,
    @Inject(NORMALIZATION_QUEUE)
    private readonly queue: Queue<NormalizationJobData>,
    @Inject(RESEND_VERIFIER) private readonly resend: ResendVerifier,
    @Inject(TWILIO_VERIFIER) private readonly twilio: TwilioVerifier,
    @Inject(WEBHOOK_TENANT_RESOLVER)
    private readonly resolveTenant: WebhookTenantResolver,
  ) {}

  /**
   * POST /webhooks/resend
   *
   * Pipeline:
   *   1. Read raw body (already populated by Nest's `rawBody: true`).
   *   2. Verify Svix HMAC against rawBody — never re-stringify.
   *   3. Compute SHA-256 checksum of rawBody.
   *   4. Insert raw_event row idempotently (svix-id is the dedupe key).
   *   5. If new, enqueue normalization job (jobId = raw_event_id).
   *   6. Return 204 No Content.
   *
   * Never logs the payload on failure. Returns reasons in a tight enum so
   * that a curious caller can't distinguish "wrong secret" from "missing
   * header" — both render as a generic 400.
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

    const result = await this.rawEvents.insertIfNotExists(
      tenantId,
      "resend",
      svixId,
      headersForStorage,
      payload,
      checksum,
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
   * POST /webhooks/twilio
   *
   * Twilio sends application/x-www-form-urlencoded. Fastify parses the body
   * into an object; raw body is still available for the checksum.
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

    const result = await this.rawEvents.insertIfNotExists(
      tenantId,
      "twilio",
      compositeId,
      headersForStorage,
      params,
      checksum,
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
