import Twilio from "twilio";

export interface TwilioDeps {
  accountSid: string;
  authToken: string;
  fromNumber: string;
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

  return {
    client,

    async sendSms(to: string, body: string) {
      return client.messages.create({
        from: deps.fromNumber,
        to,
        body,
      });
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
  };
}

export type TwilioClient = ReturnType<typeof createTwilioClient>;
