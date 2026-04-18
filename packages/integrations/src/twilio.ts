import Twilio from "twilio";

export interface TwilioDeps {
  accountSid: string;
  authToken: string;
  fromNumber: string;
  /** Full Twilio WhatsApp sender — `whatsapp:+E164`. */
  whatsappFrom?: string;
}

/**
 * Extra credentials needed to mint browser Voice SDK access tokens
 * (Sprint J — live-listen + operator-join). The API Key + Secret are
 * distinct from the Account Auth Token and MUST be generated
 * separately in the Twilio Console. The TwiML app SID routes
 * browser-originated calls to the apps/api join-TwiML endpoint which
 * returns `<Dial><Conference/>` for the requested conference name.
 */
export interface TwilioVoiceSdkDeps {
  apiKey: string;
  apiSecret: string;
  twimlAppSid: string;
}

export interface MintVoiceAccessTokenParams {
  /** Identity the Voice SDK Device registers as — typically the operator user id. */
  identity: string;
  /** Conference name the browser leg will dial into via the TwiML app. */
  conferenceName: string;
  /** Token TTL in seconds (default 1h — matches Twilio's max for safety). */
  ttlSeconds?: number;
}

export interface MintVoiceAccessTokenResult {
  token: string;
  identity: string;
  expiresAt: string;
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
     * Send a WhatsApp message via Twilio's Messages API. Requires
     * `whatsappFrom` on deps (format `whatsapp:+E164`). The `to`
     * number is automatically prefixed with `whatsapp:` if the
     * caller passed a bare E.164 string.
     */
    async sendWhatsApp(to: string, body: string) {
      if (!deps.whatsappFrom) {
        throw new Error(
          "twilio.sendWhatsApp: whatsappFrom not configured (set TWILIO_WHATSAPP_FROM)",
        );
      }
      const toAddr = to.startsWith("whatsapp:") ? to : `whatsapp:${to}`;
      return client.messages.create({
        from: deps.whatsappFrom,
        to: toAddr,
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

/**
 * Mint a Voice SDK Access Token scoped to a single TwiML application.
 * The browser's `Device.connect({ conference })` dials through the
 * TwiML app, whose Voice URL points at apps/api's join-TwiML handler.
 * That handler inspects the `conference` param and returns
 * `<Dial><Conference>{name}</Conference></Dial>` so the browser leg
 * drops into the same Conference room the callee is already in.
 *
 * Pure — takes creds + params and returns a JWT. No I/O, safe to
 * call from a request handler.
 */
export function mintVoiceAccessToken(
  creds: { accountSid: string } & TwilioVoiceSdkDeps,
  params: MintVoiceAccessTokenParams,
): MintVoiceAccessTokenResult {
  const ttl = params.ttlSeconds ?? 3600;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { AccessToken } = (Twilio as any).jwt as {
    AccessToken: new (
      accountSid: string,
      keySid: string,
      secret: string,
      options: { identity: string; ttl?: number },
    ) => {
      addGrant: (grant: unknown) => void;
      toJwt: () => string;
    } & {
      VoiceGrant: new (options: {
        incomingAllow?: boolean;
        outgoingApplicationSid?: string;
        outgoingApplicationParams?: Record<string, string>;
      }) => unknown;
    };
  };
  const token = new AccessToken(
    creds.accountSid,
    creds.apiKey,
    creds.apiSecret,
    { identity: params.identity, ttl },
  );
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const VoiceGrant = ((Twilio as any).jwt as any).AccessToken.VoiceGrant as new (
    options: {
      incomingAllow?: boolean;
      outgoingApplicationSid?: string;
      outgoingApplicationParams?: Record<string, string>;
    },
  ) => unknown;
  const grant = new VoiceGrant({
    incomingAllow: false,
    outgoingApplicationSid: creds.twimlAppSid,
    outgoingApplicationParams: { conference: params.conferenceName },
  });
  token.addGrant(grant);
  return {
    token: token.toJwt(),
    identity: params.identity,
    expiresAt: new Date(Date.now() + ttl * 1000).toISOString(),
  };
}
