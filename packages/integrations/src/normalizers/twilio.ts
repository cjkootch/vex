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
 * Twilio webhooks are application/x-www-form-urlencoded — by the time we
 * see the payload here it has been parsed into a plain object. All values
 * arrive as strings.
 */
const TwilioPayload = z
  .object({
    AccountSid: z.string().optional(),
    CallSid: z.string(),
    CallStatus: z.string(),
    From: z.string().optional(),
    To: z.string().optional(),
    Direction: z.string().optional(),
    CallDuration: z.string().optional(),
    ErrorCode: z.string().optional(),
    ErrorMessage: z.string().optional(),
  })
  .passthrough();

export class TwilioNormalizer {
  constructor(private readonly deps: NormalizerDeps) {}

  async normalize(raw: RawEventInput): Promise<NormalizerOutcome> {
    const parsed = TwilioPayload.safeParse(raw.payload);
    if (!parsed.success) {
      throw new Error(`Twilio payload failed validation: ${parsed.error.message}`);
    }
    const payload = parsed.data;
    const verb = VERB_MAP[payload.CallStatus];
    if (!verb) {
      return {
        status: "skipped",
        reason: `unknown twilio CallStatus: ${payload.CallStatus}`,
      };
    }

    const occurredAt = raw.receivedAt;
    const metadata: Record<string, unknown> = { call_sid: payload.CallSid };
    if (payload.CallDuration) {
      metadata["duration"] = Number(payload.CallDuration);
    }
    if (payload.ErrorCode) metadata["error_code"] = payload.ErrorCode;
    if (payload.ErrorMessage) metadata["error_message"] = payload.ErrorMessage;
    if (payload.From) metadata["from"] = payload.From;
    if (payload.To) metadata["to"] = payload.To;

    if (payload.CallStatus === "completed" && payload.CallDuration) {
      const seconds = Number(payload.CallDuration);
      if (Number.isFinite(seconds)) {
        await this.deps.activities.insert(this.deps.tx, raw.tenantId, {
          type: "voice_call",
          relatedObjectIds: { call_sid: payload.CallSid },
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
        subjectId: payload.CallSid,
        actorType: payload.Direction === "inbound" ? "external" : "agent",
        actorId: null,
        objectType: "phone_number",
        objectId: payload.To ?? null,
        occurredAt,
        idempotencyKey: `twilio:${payload.CallSid}:${payload.CallStatus}`,
        metadata,
      },
    );

    return { status: "ok", eventId: event.id, isNewEvent: isNew };
  }
}
