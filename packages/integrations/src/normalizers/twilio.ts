import { z } from "zod";
import type { NormalizerDeps, NormalizerOutcome, RawEventInput } from "./types.js";

/** Twilio CallStatus → canonical verb. */
const VERB_MAP: Record<string, string> = {
  initiated: "call.initiated",
  ringing: "call.ringing",
  "in-progress": "call.in_progress",
  completed: "call.completed",
  failed: "call.failed",
  "no-answer": "call.no_answer",
  busy: "call.busy",
};

/**
 * Twilio Messages API status-callback states. When MessageStatus is one of
 * these, the webhook is a delivery-update callback for an OUTBOUND message
 * we already sent; we emit a `sms.<status>` / `whatsapp.<status>` event but
 * don't write a new touchpoint (the outbound `.sent` row was written by
 * the executor at send time).
 */
const OUTBOUND_MESSAGE_STATUSES = new Set([
  "accepted",
  "queued",
  "sending",
  "sent",
  "delivered",
  "failed",
  "undelivered",
  "read",
]);

/**
 * Twilio webhooks are application/x-www-form-urlencoded — by the time we
 * see the payload here it has been parsed into a plain object. All values
 * arrive as strings.
 *
 * One schema covers three webhook shapes:
 *   - Voice status callback (CallSid + CallStatus required)
 *   - Inbound SMS / WhatsApp message (MessageSid + Body present, MessageStatus absent)
 *   - Outbound message status callback (MessageSid + MessageStatus in OUTBOUND_MESSAGE_STATUSES)
 *
 * Discrimination happens inside `normalize()` after parse.
 */
const TwilioPayload = z
  .object({
    AccountSid: z.string().optional(),
    // Voice fields
    CallSid: z.string().optional(),
    CallStatus: z.string().optional(),
    CallDuration: z.string().optional(),
    // Messaging fields
    MessageSid: z.string().optional(),
    MessageStatus: z.string().optional(),
    SmsStatus: z.string().optional(),
    Body: z.string().optional(),
    NumMedia: z.string().optional(),
    NumSegments: z.string().optional(),
    // Common
    From: z.string().optional(),
    To: z.string().optional(),
    Direction: z.string().optional(),
    ErrorCode: z.string().optional(),
    ErrorMessage: z.string().optional(),
  })
  .passthrough();

/** First-N chars of the body, used for list views. */
const PREVIEW_CHARS = 240;

/** Strip `whatsapp:` channel prefix to get a bare E.164 number. */
function stripChannelPrefix(addr: string): string {
  return addr.replace(/^whatsapp:/i, "");
}

/** Twilio prefixes WhatsApp From/To with `whatsapp:`; bare numbers are SMS. */
function detectChannel(from: string | undefined, to: string | undefined): "sms" | "whatsapp" {
  if (from?.toLowerCase().startsWith("whatsapp:")) return "whatsapp";
  if (to?.toLowerCase().startsWith("whatsapp:")) return "whatsapp";
  return "sms";
}

export class TwilioNormalizer {
  constructor(private readonly deps: NormalizerDeps) {}

  async normalize(raw: RawEventInput): Promise<NormalizerOutcome> {
    const parsed = TwilioPayload.safeParse(raw.payload);
    if (!parsed.success) {
      throw new Error(`Twilio payload failed validation: ${parsed.error.message}`);
    }
    const payload = parsed.data;

    if (payload.CallSid && payload.CallStatus) {
      return this.normalizeVoice(raw, payload);
    }
    if (payload.MessageSid) {
      return this.normalizeMessage(raw, payload);
    }
    return {
      status: "skipped",
      reason: "twilio webhook with neither CallSid nor MessageSid",
    };
  }

  private async normalizeVoice(
    raw: RawEventInput,
    payload: z.infer<typeof TwilioPayload>,
  ): Promise<NormalizerOutcome> {
    const callSid = payload.CallSid!;
    const callStatus = payload.CallStatus!;
    const verb = VERB_MAP[callStatus];
    if (!verb) {
      return {
        status: "skipped",
        reason: `unknown twilio CallStatus: ${callStatus}`,
      };
    }

    const occurredAt = raw.receivedAt;
    const metadata: Record<string, unknown> = { call_sid: callSid };
    if (payload.CallDuration) {
      metadata["duration"] = Number(payload.CallDuration);
    }
    if (payload.ErrorCode) metadata["error_code"] = payload.ErrorCode;
    if (payload.ErrorMessage) metadata["error_message"] = payload.ErrorMessage;
    if (payload.From) metadata["from"] = payload.From;
    if (payload.To) metadata["to"] = payload.To;

    if (callStatus === "completed" && payload.CallDuration) {
      const seconds = Number(payload.CallDuration);
      if (Number.isFinite(seconds)) {
        await this.deps.activities.insert(this.deps.tx, raw.tenantId, {
          type: "voice_call",
          relatedObjectIds: { call_sid: callSid },
          occurredAt,
          result: "completed",
          durationSeconds: seconds,
          metadata,
        });
      }
    }

    const { event, isNew } = await this.deps.events.insertIfNotExists(
      this.deps.tx,
      raw.tenantId,
      {
        verb,
        subjectType: "call",
        subjectId: callSid,
        actorType: payload.Direction === "inbound" ? "external" : "agent",
        actorId: null,
        objectType: "phone_number",
        objectId: payload.To ?? null,
        occurredAt,
        idempotencyKey: `twilio:${callSid}:${callStatus}`,
        metadata,
      },
    );

    return { status: "ok", eventId: event.id, isNewEvent: isNew };
  }

  private async normalizeMessage(
    raw: RawEventInput,
    payload: z.infer<typeof TwilioPayload>,
  ): Promise<NormalizerOutcome> {
    const channel = detectChannel(payload.From, payload.To);

    const isStatusCallback =
      payload.MessageStatus !== undefined &&
      OUTBOUND_MESSAGE_STATUSES.has(payload.MessageStatus);

    if (isStatusCallback) {
      return this.normalizeOutboundStatus(raw, payload, channel);
    }
    return this.normalizeInboundMessage(raw, payload, channel);
  }

  private async normalizeInboundMessage(
    raw: RawEventInput,
    payload: z.infer<typeof TwilioPayload>,
    channel: "sms" | "whatsapp",
  ): Promise<NormalizerOutcome> {
    const messageSid = payload.MessageSid!;
    const fromRaw = payload.From ?? "";
    const toRaw = payload.To ?? "";
    const fromPhone = stripChannelPrefix(fromRaw);
    const toPhone = stripChannelPrefix(toRaw);
    const body = payload.Body ?? "";
    const preview = body.slice(0, PREVIEW_CHARS).trim();
    const occurredAt = raw.receivedAt;

    // Resolve the sender to an existing contact. Touchpoint still
    // lands with contactId=null when nothing matches so the operator
    // can triage in the inbox; we don't create contacts speculatively
    // from inbound numbers.
    const contact = fromPhone
      ? await this.deps.contacts.findByPhone(this.deps.tx, fromPhone)
      : null;

    const metadata: Record<string, unknown> = {
      direction: "inbound",
      verb: `${channel}.received`,
      provider_message_id: messageSid,
      from: fromRaw,
      to: toRaw,
      ...(body ? { text: body, preview } : {}),
      ...(payload.NumMedia ? { num_media: Number(payload.NumMedia) } : {}),
      ...(payload.NumSegments ? { num_segments: Number(payload.NumSegments) } : {}),
    };

    const touchpoint = await this.deps.touchpoints.insert(this.deps.tx, raw.tenantId, {
      channel: `${channel}.received`,
      actor: `twilio:${fromRaw}`,
      occurredAt,
      contactId: contact?.id ?? null,
      orgId: contact?.orgId ?? null,
      metadata,
    });

    const { event, isNew } = await this.deps.events.insertIfNotExists(
      this.deps.tx,
      raw.tenantId,
      {
        verb: `${channel}.received`,
        subjectType: "contact",
        subjectId: contact?.id ?? fromPhone,
        actorType: "contact",
        actorId: contact?.id ?? null,
        objectType: "phone_number",
        objectId: toPhone,
        occurredAt,
        idempotencyKey: `${channel}.received:${messageSid}`,
        metadata: {
          provider_message_id: messageSid,
          from: fromRaw,
          ...(preview ? { preview } : {}),
          matched_contact: contact?.id ?? null,
        },
      },
    );

    return {
      status: "ok",
      eventId: event.id,
      isNewEvent: isNew,
      touchpointId: touchpoint.id,
    };
  }

  private async normalizeOutboundStatus(
    raw: RawEventInput,
    payload: z.infer<typeof TwilioPayload>,
    channel: "sms" | "whatsapp",
  ): Promise<NormalizerOutcome> {
    const messageSid = payload.MessageSid!;
    const status = payload.MessageStatus!;
    const occurredAt = raw.receivedAt;

    const metadata: Record<string, unknown> = {
      provider_message_id: messageSid,
      message_status: status,
      ...(payload.From ? { from: payload.From } : {}),
      ...(payload.To ? { to: payload.To } : {}),
      ...(payload.ErrorCode ? { error_code: payload.ErrorCode } : {}),
      ...(payload.ErrorMessage ? { error_message: payload.ErrorMessage } : {}),
    };

    const { event, isNew } = await this.deps.events.insertIfNotExists(
      this.deps.tx,
      raw.tenantId,
      {
        verb: `${channel}.${status}`,
        subjectType: "message",
        subjectId: messageSid,
        actorType: "agent",
        actorId: null,
        objectType: "phone_number",
        objectId: payload.To ? stripChannelPrefix(payload.To) : null,
        occurredAt,
        idempotencyKey: `${channel}:${messageSid}:${status}`,
        metadata,
      },
    );

    return { status: "ok", eventId: event.id, isNewEvent: isNew };
  }
}
