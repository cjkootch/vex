import Twilio from "twilio";

export interface TwilioDeps {
  accountSid: string;
  authToken: string;
  fromNumber: string;
  /**
   * Optional WhatsApp sender in `whatsapp:+E164` form. When absent, the
   * WhatsApp send method throws a typed "whatsapp_not_configured" error
   * the executor converts to `approval.executor.failed`.
   */
  whatsappFrom?: string;
}

export interface SendMessageResult {
  /** Twilio message SID — idempotency key for the approval row. */
  sid: string | null;
  /** Non-null when the provider rejected the send synchronously. */
  error: string | null;
  /** Outbound segment count Twilio reports for SMS; null for WhatsApp. */
  segments: number | null;
}

export interface SendSmsParams {
  /** E.164 destination phone number. */
  to: string;
  /** Plain-text body. Twilio auto-segments at 160 GSM-7 / 70 UCS-2 chars. */
  body: string;
  /** Optional status callback — if set, Twilio POSTs message lifecycle there. */
  statusCallback?: string;
}

export interface SendWhatsAppParams {
  /** E.164 destination phone number (no `whatsapp:` prefix — we add it). */
  to: string;
  /**
   * Content SID for a pre-approved WhatsApp template. Required for
   * business-initiated messages outside the 24h customer-service window.
   * Omit when replying within an open session.
   */
  contentSid?: string;
  /** Variables the template references (`{{1}}`, `{{2}}`, …). */
  contentVariables?: Record<string, string>;
  /**
   * Free-form body. Allowed only when replying within Meta's 24h
   * customer-service window — outbound-initiated messages MUST use a
   * template. Callers that can't prove the window is open should set
   * `contentSid` and skip `body`.
   */
  body?: string;
  statusCallback?: string;
}

export interface CreateOutboundCallParams {
  /** E.164 destination number. */
  to: string;
  /**
   * Public HTTPS URL Twilio will request to drive the call script (TwiML).
   * In Vex, points at an apps/api route that returns `<Say>...</Say>`
   * based on the call's workflow context.
   */
  twimlUrl: string;
  /** Public HTTPS URL for call-lifecycle status callbacks. */
  statusCallback: string;
  /** Events the status callback should fire for. Default: initiated / ringing / answered / completed. */
  statusCallbackEvent?: readonly (
    | "initiated"
    | "ringing"
    | "answered"
    | "completed"
  )[];
  /** Public HTTPS URL for recording-status callbacks. When omitted recordings still happen but no callback fires. */
  recordingStatusCallback?: string;
  /** Enable call recording. Defaults to true for Vex outbound calls. */
  record?: boolean;
  /** Optional timeout in seconds before the call is considered a no-answer. Default 30. */
  timeout?: number;
}

export interface CreateOutboundCallResult {
  callSid: string;
  status: string;
}

/**
 * Construct a Twilio client for PSTN voice and SMS. Per-call minute cost
 * accounting lives in the worker that consumes Twilio status webhooks.
 *
 * Sprint 12 adds outbound-call creation and recording downloads used by
 * the OutboundCallWorkflow. All outbound calls flow through this client
 * so the T3 approval gate and the workflow state machine stay in control
 * of when a real phone call fires.
 */
export function createTwilioClient(deps: TwilioDeps) {
  const client = Twilio(deps.accountSid, deps.authToken);

  const whatsappFrom = deps.whatsappFrom ?? null;

  return {
    client,

    /**
     * Send an SMS through the configured `fromNumber`. Returns a
     * normalised `SendMessageResult` — the executor doesn't touch the
     * Twilio SDK type surface. Throws only on unexpected SDK errors;
     * provider-level rejections (blacklist, invalid E.164) surface via
     * `result.error` so callers can distinguish retry vs fail-closed.
     */
    async sendSms(params: SendSmsParams): Promise<SendMessageResult> {
      try {
        const message = await client.messages.create({
          from: deps.fromNumber,
          to: params.to,
          body: params.body,
          ...(params.statusCallback
            ? { statusCallback: params.statusCallback }
            : {}),
        });
        return {
          sid: message.sid ?? null,
          error: null,
          segments: message.numSegments
            ? Number.parseInt(String(message.numSegments), 10)
            : null,
        };
      } catch (err) {
        return {
          sid: null,
          error: describeTwilioError(err),
          segments: null,
        };
      }
    },

    /**
     * Send a WhatsApp message. Business-initiated sends outside the
     * 24h customer-service window MUST specify `contentSid`; free-form
     * `body` is allowed only inside an open session. Caller is
     * responsible for enforcing that distinction — we surface the
     * Twilio error intact if it rejects on that rule.
     *
     * Throws a typed `whatsapp_not_configured` error when the
     * adapter was constructed without `whatsappFrom`.
     */
    async sendWhatsApp(
      params: SendWhatsAppParams,
    ): Promise<SendMessageResult> {
      if (!whatsappFrom) {
        return {
          sid: null,
          error: "whatsapp_not_configured",
          segments: null,
        };
      }
      if (!params.contentSid && !params.body) {
        return {
          sid: null,
          error: "whatsapp_missing_template_or_body",
          segments: null,
        };
      }
      try {
        const message = await client.messages.create({
          from: whatsappFrom,
          to: `whatsapp:${params.to}`,
          ...(params.contentSid
            ? { contentSid: params.contentSid }
            : { body: params.body! }),
          ...(params.contentVariables
            ? { contentVariables: JSON.stringify(params.contentVariables) }
            : {}),
          ...(params.statusCallback
            ? { statusCallback: params.statusCallback }
            : {}),
        });
        return {
          sid: message.sid ?? null,
          error: null,
          segments: null,
        };
      } catch (err) {
        return {
          sid: null,
          error: describeTwilioError(err),
          segments: null,
        };
      }
    },

    /**
     * Create an outbound PSTN call. The workflow has already cleared the
     * call window, suppression, and T3 approval checks before this runs.
     * `record: true` is the default so Sprint 12 transcripts always have
     * audio to transcribe.
     */
    async createOutboundCall(
      params: CreateOutboundCallParams,
    ): Promise<CreateOutboundCallResult> {
      const call = await client.calls.create({
        from: deps.fromNumber,
        to: params.to,
        url: params.twimlUrl,
        method: "POST",
        statusCallback: params.statusCallback,
        statusCallbackMethod: "POST",
        statusCallbackEvent: [
          ...(params.statusCallbackEvent ?? [
            "initiated",
            "ringing",
            "answered",
            "completed",
          ]),
        ],
        record: params.record ?? true,
        ...(params.recordingStatusCallback
          ? {
              recordingStatusCallback: params.recordingStatusCallback,
              recordingStatusCallbackEvent: ["completed", "failed"],
              recordingStatusCallbackMethod: "POST",
            }
          : {}),
        timeout: params.timeout ?? 30,
      });
      return { callSid: call.sid, status: call.status };
    },

    /**
     * Download a Twilio recording by its public recording URL. Twilio
     * recordings are behind basic-auth with the account SID + auth token,
     * so we can't rely on a pre-signed URL.
     *
     * Returns the raw audio bytes; callers are responsible for uploading
     * to Vex's own object storage per the invariant "never store a raw
     * provider URL in the DB as the canonical reference".
     */
    async downloadRecording(recordingUrl: string): Promise<Buffer> {
      const auth = Buffer.from(
        `${deps.accountSid}:${deps.authToken}`,
      ).toString("base64");
      const res = await fetch(recordingUrl, {
        headers: { authorization: `Basic ${auth}` },
      });
      if (!res.ok) {
        throw new Error(
          `twilio recording fetch failed: ${res.status} ${res.statusText}`,
        );
      }
      const arrayBuf = await res.arrayBuffer();
      return Buffer.from(arrayBuf);
    },

    /**
     * Canonical S3 object key for a Twilio recording. Tenant-prefixed so
     * RLS at the storage layer mirrors the DB RLS model.
     */
    recordingStorageKey(tenantId: string, callSid: string): string {
      return `recordings/${tenantId}/${callSid}.mp3`;
    },

    /** Whether this client was configured with a WhatsApp sender. */
    get whatsappConfigured(): boolean {
      return whatsappFrom !== null;
    },
  };
}

export type TwilioClient = ReturnType<typeof createTwilioClient>;

function describeTwilioError(err: unknown): string {
  if (err instanceof Error) {
    // Twilio SDK errors carry a numeric `code` on top of `message`. Surface
    // both so approval.executor.failed metadata is debuggable without
    // grepping provider docs.
    const code = (err as { code?: unknown }).code;
    return typeof code === "number"
      ? `${code}: ${err.message}`
      : err.message;
  }
  return String(err);
}
