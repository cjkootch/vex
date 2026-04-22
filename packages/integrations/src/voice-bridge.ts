/**
 * Sprint K — real-time escalation-listener bridge between a Twilio
 * Media Stream (callee leg audio) and an OpenAI Realtime session.
 *
 * The AI listens passively; its only tool is `escalate_to_human`,
 * fired when the callee asks for a human / expresses escalation
 * intent. The bridge is stateful per-call (one instance per WS
 * upgrade) but the class is pure — all I/O happens through the
 * injected transports so unit tests can exercise the message
 * routing without opening sockets.
 *
 * Audio is forwarded byte-identically — both Twilio and OpenAI
 * Realtime support `g711_ulaw` 8kHz mono, so no codec conversion is
 * needed for Sprint K. When Sprint L adds AI talkback into the
 * conference, that leg will run PCM16@24kHz and need resampling.
 */

/** Minimal duplex transport for the Twilio Media Stream WebSocket. */
export interface TwilioStreamTransport {
  /** Register a handler called for every Twilio Stream event payload. */
  onMessage(handler: (msg: TwilioStreamMessage) => void): void;
  /** Register a handler called when Twilio closes the connection. */
  onClose(handler: (reason?: string) => void): void;
  /** Send a Stream message to Twilio (e.g. to play audio back). */
  send(msg: TwilioStreamMessage): void;
  /** Close from our side. */
  close(code?: number, reason?: string): void;
}

/** Minimal duplex transport for the OpenAI Realtime WebSocket. */
export interface RealtimeTransport {
  onEvent(handler: (event: RealtimeServerEvent) => void): void;
  onClose(handler: (reason?: string) => void): void;
  send(event: RealtimeClientEvent): void;
  close(code?: number, reason?: string): void;
}

// ---------------------------------------------------------------------------
// Twilio Media Stream protocol — narrow slice.
// https://www.twilio.com/docs/voice/twiml/stream#websocket-messages
// ---------------------------------------------------------------------------

export type TwilioStreamMessage =
  | { event: "connected"; protocol: string; version: string }
  | {
      event: "start";
      start: {
        streamSid: string;
        accountSid: string;
        callSid: string;
        tracks: string[];
        mediaFormat: { encoding: string; sampleRate: number; channels: number };
        customParameters?: Record<string, string>;
      };
      streamSid: string;
    }
  | {
      event: "media";
      media: {
        track: string;
        chunk: string;
        timestamp: string;
        payload: string; // base64 μ-law audio
      };
      streamSid: string;
    }
  | { event: "stop"; streamSid: string; stop: { accountSid: string; callSid: string } }
  | { event: "mark"; streamSid: string; mark: { name: string } }
  // Outbound messages we send TO Twilio when running in talkback
  // mode — inject base64-encoded audio back into the call leg so the
  // AI's speech is heard by the caller. The `media.payload` format
  // matches Twilio's expected shape (different from the inbound
  // `media` variant above which also carries track/chunk/timestamp).
  | {
      event: "media";
      streamSid: string;
      media: { payload: string };
    }
  | { event: "clear"; streamSid: string };

// ---------------------------------------------------------------------------
// OpenAI Realtime events — minimal slice we actually emit/consume.
// ---------------------------------------------------------------------------

export type RealtimeVoice =
  | "alloy"
  | "ash"
  | "ballad"
  | "coral"
  | "echo"
  | "sage"
  | "shimmer"
  | "verse";

export type RealtimeClientEvent =
  | {
      type: "session.update";
      session: {
        instructions?: string;
        input_audio_format?: "pcm16" | "g711_ulaw" | "g711_alaw";
        output_audio_format?: "pcm16" | "g711_ulaw" | "g711_alaw";
        turn_detection?: {
          type: "server_vad";
          threshold?: number;
          prefix_padding_ms?: number;
          silence_duration_ms?: number;
        };
        tools?: RealtimeToolDefinition[];
        tool_choice?: "auto" | "none" | "required";
        modalities?: readonly ("audio" | "text")[];
        /** Voice preset for audio output. Only used in talkback mode. */
        voice?: RealtimeVoice;
      };
    }
  | { type: "input_audio_buffer.append"; audio: string }
  | { type: "response.cancel" }
  | { type: "input_audio_buffer.commit" }
  | {
      type: "conversation.item.create";
      item: {
        type: "function_call_output";
        call_id: string;
        output: string;
      };
    }
  | { type: "response.create"; response?: { modalities?: readonly ("audio" | "text")[] } };

export interface RealtimeToolDefinition {
  type: "function";
  name: string;
  description: string;
  parameters: {
    type: "object";
    properties: Record<string, unknown>;
    required?: string[];
  };
}

/**
 * OpenAI events we react to. The real protocol has many more event
 * types (transcripts, audio deltas, etc.) but Sprint K only needs
 * function-call dispatch + close signalling.
 */
export type RealtimeServerEvent =
  | { type: "session.created"; session: { id: string } }
  | { type: "session.updated"; session: { id: string } }
  | {
      type: "response.function_call_arguments.done";
      name: string;
      call_id: string;
      arguments: string;
      response_id: string;
    }
  // Talkback audio response — `delta` is base64 g711_ulaw audio that
  // we forward directly to Twilio as an outbound media message.
  | { type: "response.audio.delta"; delta: string; response_id: string }
  | { type: "response.audio.done"; response_id: string }
  // Speech-started fires when OpenAI's VAD detects the callee
  // speaking mid-response; we use it to cancel the in-flight AI
  // response and clear Twilio's buffered outbound audio so the
  // callee doesn't hear the AI talk over them.
  | { type: "input_audio_buffer.speech_started" }
  | {
      type: "error";
      error: { type: string; message: string; code?: string };
    };

// ---------------------------------------------------------------------------
// Bridge configuration & lifecycle.
// ---------------------------------------------------------------------------

export interface VoiceBridgeConfig {
  /** Workflow id of the call being listened to. Passed through to tools. */
  workflowId: string;
  /** Tenant id — carried into escalation-tool invocations for RLS. */
  tenantId: string;
  /** System instructions for the listening AI. */
  instructions: string;
  /** Tool definitions exposed to the AI. */
  tools: RealtimeToolDefinition[];
  /** Invoked when the AI fires the `escalate_to_human` tool. */
  onEscalate: (args: {
    reason: string;
    workflowId: string;
    tenantId: string;
    callId: string;
  }) => Promise<void> | void;
  /**
   * Invoked when the AI fires the `opt_out_contact` tool. Handler is
   * responsible for persisting the contact.opt_out (via apps/api) and
   * suppressing future outreach. After the handler resolves, the bridge
   * lets the AI deliver the goodbye line and then closes the call.
   */
  onDoNotContact?: (args: {
    reason: string;
    workflowId: string;
    tenantId: string;
    callId: string;
  }) => Promise<void> | void;
  /**
   * Invoked when the AI fires the `schedule_callback` tool because the
   * callee asked to be called back at a specific time. Handler should
   * create a `follow_up.schedule` approval (or equivalent DB write)
   * so the commitment doesn't get lost in the transcript. Bridge
   * does NOT close the call on this tool — the AI usually confirms
   * the time and wraps naturally.
   */
  onScheduleCallback?: (args: {
    dueAt: string;
    note: string;
    workflowId: string;
    tenantId: string;
    callId: string;
  }) => Promise<void> | void;
  /**
   * Sprint K was listen-only; Sprint L adds `"talkback"` — the AI
   * speaks back into the call via Twilio Stream's outbound media
   * messages. In talkback mode the session is configured with audio
   * modality + a voice preset, and the bridge forwards OpenAI's
   * audio deltas to Twilio. Default is `"listen"` for backwards
   * compatibility with Sprint K's escalation listener.
   */
  mode?: "listen" | "talkback";
  /** Voice preset used when mode = "talkback". Default `"shimmer"`. */
  voice?: RealtimeVoice;
  /**
   * Tuning for OpenAI Realtime's server-side VAD. Phone calls carry
   * coughs, background chatter, line noise — the default 0.5/500ms
   * settings are tuned for a quiet room and over-trigger on any
   * transient sound. Bumping threshold and silence_duration_ms makes
   * the AI wait longer before deciding the callee stopped speaking.
   */
  turnDetection?: {
    threshold?: number;
    prefixPaddingMs?: number;
    silenceDurationMs?: number;
  };
  /**
   * Delay between Twilio's "start" event and the first
   * `response.create` on talkback calls. Gives the outbound audio
   * path time to stabilise so the AI's opening sentence doesn't get
   * clipped. Default 1500ms.
   */
  openingDelayMs?: number;
  /** Optional logger — defaults to no-op. */
  log?: (level: "info" | "warn" | "error", msg: string, meta?: object) => void;
}

export interface VoiceBridgeHandle {
  /** Close both transports. Safe to call more than once. */
  close(): void;
  /** Stats for diagnostics / tests. */
  stats(): {
    framesForwarded: number;
    framesReturned: number;
    escalations: number;
    optOuts: number;
    callbacksScheduled: number;
    closed: boolean;
  };
}

/**
 * Wire a Twilio Stream transport and an OpenAI Realtime transport
 * into a listener session. Returns a handle whose `close()` tears
 * down both sides cleanly.
 *
 * On first `start` from Twilio we:
 *   1. Configure the Realtime session (`session.update`) with the
 *      listener instructions + tools + g711_ulaw audio format.
 *   2. Begin forwarding `media` frames as `input_audio_buffer.append`.
 *
 * On `response.function_call_arguments.done` for the escalate tool:
 *   3. Parse the args JSON, invoke `onEscalate`, and send a
 *      function_call_output back so the session stays in a valid
 *      state for further turns.
 *
 * On stop or either side closing: tear down.
 */
export function startVoiceBridge(
  twilio: TwilioStreamTransport,
  realtime: RealtimeTransport,
  config: VoiceBridgeConfig,
): VoiceBridgeHandle {
  const log =
    config.log ??
    ((_level: string, _msg: string, _meta?: object): void => {
      /* no-op */
    });

  const mode = config.mode ?? "listen";
  const voice = config.voice ?? "shimmer";
  let framesForwarded = 0;
  let framesReturned = 0;
  let escalations = 0;
  let optOuts = 0;
  let callbacksScheduled = 0;
  let closed = false;
  let callId: string | null = null;
  let streamSid: string | null = null;
  let started = false;

  function cleanup(): void {
    if (closed) return;
    closed = true;
    try {
      twilio.close();
    } catch {
      /* transport already torn down */
    }
    try {
      realtime.close();
    } catch {
      /* transport already torn down */
    }
  }

  twilio.onMessage((msg) => {
    if (closed) return;
    switch (msg.event) {
      case "connected":
        return;
      case "start":
        if (started) return;
        started = true;
        callId = msg.start.callSid;
        streamSid = msg.streamSid;
        realtime.send({
          type: "session.update",
          session: {
            instructions: config.instructions,
            input_audio_format: "g711_ulaw",
            output_audio_format: "g711_ulaw",
            modalities: mode === "talkback" ? ["audio", "text"] : ["text"],
            ...(mode === "talkback" ? { voice } : {}),
            turn_detection: {
              type: "server_vad",
              threshold: config.turnDetection?.threshold ?? 0.7,
              prefix_padding_ms:
                config.turnDetection?.prefixPaddingMs ?? 300,
              silence_duration_ms:
                config.turnDetection?.silenceDurationMs ?? 900,
            },
            tools: config.tools,
            tool_choice: "auto",
          },
        });
        // Kick off AI speech so the callee hears a greeting. Delay
        // briefly so Twilio's outbound audio path is fully stable —
        // firing response.create too early reliably clips the first
        // ~500ms of the AI's opening sentence, which shows up as a
        // "fumble" on the callee's end.
        if (mode === "talkback") {
          const openingDelayMs = config.openingDelayMs ?? 1500;
          setTimeout(() => {
            if (closed) return;
            realtime.send({
              type: "response.create",
              response: { modalities: ["audio", "text"] },
            });
          }, openingDelayMs);
        }
        log("info", "voice bridge started", {
          workflowId: config.workflowId,
          callId,
          streamSid,
          mode,
        });
        return;
      case "media":
        if (!started) return;
        realtime.send({
          type: "input_audio_buffer.append",
          audio: msg.media.payload,
        });
        framesForwarded += 1;
        return;
      case "stop":
        log("info", "twilio stream stopped", {
          workflowId: config.workflowId,
          callId,
          framesForwarded,
        });
        cleanup();
        return;
      case "mark":
        return;
    }
  });

  twilio.onClose((reason) => {
    log("info", "twilio transport closed", {
      workflowId: config.workflowId,
      reason,
    });
    cleanup();
  });

  realtime.onEvent((event) => {
    if (closed) return;
    switch (event.type) {
      case "session.created":
      case "session.updated":
      case "response.audio.done":
        return;
      case "response.audio.delta":
        if (mode === "talkback" && streamSid) {
          twilio.send({
            event: "media",
            streamSid,
            media: { payload: event.delta },
          });
          framesReturned += 1;
        }
        return;
      case "input_audio_buffer.speech_started":
        // Callee started talking — in talkback mode, barge-in: cancel
        // any in-flight AI response and clear Twilio's buffered
        // outbound audio so the callee hears themselves, not the AI
        // still speaking over them.
        if (mode === "talkback" && streamSid) {
          realtime.send({ type: "response.cancel" });
          twilio.send({ event: "clear", streamSid });
        }
        return;
      case "error":
        log("error", `realtime error: ${event.error.message}`, {
          workflowId: config.workflowId,
          code: event.error.code,
          type: event.error.type,
        });
        return;
      case "response.function_call_arguments.done":
        if (event.name === "escalate_to_human") {
          void handleEscalation(event);
          return;
        }
        if (event.name === "opt_out_contact") {
          void handleOptOut(event);
          return;
        }
        if (event.name === "schedule_callback") {
          void handleScheduleCallback(event);
          return;
        }
        log("warn", `unknown tool invoked: ${event.name}`, {
          workflowId: config.workflowId,
        });
        return;
    }
  });

  realtime.onClose((reason) => {
    log("info", "realtime transport closed", {
      workflowId: config.workflowId,
      reason,
    });
    cleanup();
  });

  async function handleEscalation(
    event: Extract<
      RealtimeServerEvent,
      { type: "response.function_call_arguments.done" }
    >,
  ): Promise<void> {
    let parsed: { reason?: unknown } = {};
    try {
      parsed = JSON.parse(event.arguments) as { reason?: unknown };
    } catch {
      log("warn", "escalation args not JSON; using empty reason", {
        workflowId: config.workflowId,
      });
    }
    const reason = typeof parsed.reason === "string" ? parsed.reason : "ai-detected escalation";
    try {
      await config.onEscalate({
        reason,
        workflowId: config.workflowId,
        tenantId: config.tenantId,
        callId: callId ?? "unknown",
      });
      escalations += 1;
      realtime.send({
        type: "conversation.item.create",
        item: {
          type: "function_call_output",
          call_id: event.call_id,
          output: JSON.stringify({
            ok: true,
            message:
              "A teammate has been paged. Let the caller know someone will join shortly.",
          }),
        },
      });
      // Critical: Realtime doesn't auto-speak after a tool call —
      // without this the AI stays silent after escalation and the
      // callee hears dead air. Prompt a fresh audio response so the
      // AI acknowledges the hand-off.
      if (mode === "talkback") {
        realtime.send({
          type: "response.create",
          response: { modalities: ["audio", "text"] },
        });
      }
      log("info", "escalation fired", {
        workflowId: config.workflowId,
        reason,
      });
    } catch (err) {
      realtime.send({
        type: "conversation.item.create",
        item: {
          type: "function_call_output",
          call_id: event.call_id,
          output: JSON.stringify({
            ok: false,
            error: (err as Error).message,
            message:
              "Escalation failed — apologise to the caller and offer to take a message.",
          }),
        },
      });
      if (mode === "talkback") {
        realtime.send({
          type: "response.create",
          response: { modalities: ["audio", "text"] },
        });
      }
      log("error", `escalation handler threw: ${(err as Error).message}`, {
        workflowId: config.workflowId,
      });
    }
  }

  async function handleOptOut(
    event: Extract<
      RealtimeServerEvent,
      { type: "response.function_call_arguments.done" }
    >,
  ): Promise<void> {
    let parsed: { reason?: unknown } = {};
    try {
      parsed = JSON.parse(event.arguments) as { reason?: unknown };
    } catch {
      log("warn", "opt-out args not JSON; using empty reason", {
        workflowId: config.workflowId,
      });
    }
    const reason =
      typeof parsed.reason === "string"
        ? parsed.reason
        : "callee requested opt-out";
    const toolOk = async (message: string): Promise<void> => {
      realtime.send({
        type: "conversation.item.create",
        item: {
          type: "function_call_output",
          call_id: event.call_id,
          output: JSON.stringify({ ok: true, message }),
        },
      });
      if (mode === "talkback") {
        realtime.send({
          type: "response.create",
          response: { modalities: ["audio", "text"] },
        });
      }
    };
    try {
      if (config.onDoNotContact) {
        await config.onDoNotContact({
          reason,
          workflowId: config.workflowId,
          tenantId: config.tenantId,
          callId: callId ?? "unknown",
        });
      }
      optOuts += 1;
      await toolOk(
        "Contact marked as opted out. Deliver a short, respectful goodbye, then the system will hang up.",
      );
      // Give the AI ~4s to deliver its goodbye line, then cleanly tear
      // down the call. Hard-cap on the goodbye so an aborted audio
      // response doesn't leave the line hanging open.
      setTimeout(() => {
        if (closed) return;
        log("info", "opt-out closing call", {
          workflowId: config.workflowId,
          reason,
        });
        cleanup();
      }, 4_000);
      log("info", "opt-out fired", {
        workflowId: config.workflowId,
        reason,
      });
    } catch (err) {
      realtime.send({
        type: "conversation.item.create",
        item: {
          type: "function_call_output",
          call_id: event.call_id,
          output: JSON.stringify({
            ok: false,
            error: (err as Error).message,
            message:
              "Opt-out write failed — still close the call warmly; the system will log the failure for manual processing.",
          }),
        },
      });
      if (mode === "talkback") {
        realtime.send({
          type: "response.create",
          response: { modalities: ["audio", "text"] },
        });
      }
      log("error", `opt-out handler threw: ${(err as Error).message}`, {
        workflowId: config.workflowId,
      });
    }
  }

  async function handleScheduleCallback(
    event: Extract<
      RealtimeServerEvent,
      { type: "response.function_call_arguments.done" }
    >,
  ): Promise<void> {
    let parsed: { dueAt?: unknown; note?: unknown } = {};
    try {
      parsed = JSON.parse(event.arguments) as typeof parsed;
    } catch {
      log("warn", "schedule-callback args not JSON; dropping", {
        workflowId: config.workflowId,
      });
    }
    const dueAt = typeof parsed.dueAt === "string" ? parsed.dueAt : "";
    const note = typeof parsed.note === "string" ? parsed.note : "";
    const valid = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?Z$/.test(
      dueAt,
    );

    const toolOk = async (message: string): Promise<void> => {
      realtime.send({
        type: "conversation.item.create",
        item: {
          type: "function_call_output",
          call_id: event.call_id,
          output: JSON.stringify({ ok: true, message }),
        },
      });
      if (mode === "talkback") {
        realtime.send({
          type: "response.create",
          response: { modalities: ["audio", "text"] },
        });
      }
    };
    const toolErr = async (err: string): Promise<void> => {
      realtime.send({
        type: "conversation.item.create",
        item: {
          type: "function_call_output",
          call_id: event.call_id,
          output: JSON.stringify({
            ok: false,
            error: err,
            message:
              "Couldn't schedule the callback automatically. Confirm verbally and tell the callee the team will note it manually.",
          }),
        },
      });
      if (mode === "talkback") {
        realtime.send({
          type: "response.create",
          response: { modalities: ["audio", "text"] },
        });
      }
    };

    if (!valid) {
      log("warn", "schedule-callback got invalid dueAt", {
        workflowId: config.workflowId,
        dueAt,
      });
      await toolErr("invalid_dueAt_format");
      return;
    }
    try {
      if (config.onScheduleCallback) {
        await config.onScheduleCallback({
          dueAt,
          note,
          workflowId: config.workflowId,
          tenantId: config.tenantId,
          callId: callId ?? "unknown",
        });
      }
      callbacksScheduled += 1;
      await toolOk(
        "Callback scheduled. Confirm the time back to the callee naturally and carry on.",
      );
      log("info", "schedule-callback fired", {
        workflowId: config.workflowId,
        dueAt,
      });
    } catch (err) {
      log(
        "error",
        `schedule-callback handler threw: ${(err as Error).message}`,
        { workflowId: config.workflowId },
      );
      await toolErr((err as Error).message);
    }
  }

  return {
    close: cleanup,
    stats: () => ({
      framesForwarded,
      framesReturned,
      escalations,
      optOuts,
      callbacksScheduled,
      closed,
    }),
  };
}

// ---------------------------------------------------------------------------
// Canonical listener prompt + tool schema.
// ---------------------------------------------------------------------------

/**
 * System instructions for the escalation-listener session. The AI
 * never speaks in Sprint K (output modality is set to `text` in the
 * session update); its job is to monitor the conversation and fire
 * the escalation tool when the callee signals they want a human.
 *
 * Kept deliberately short — Realtime sessions take a fresh copy of
 * these instructions every time the session is created (no caching),
 * so longer prompts pay a bigger per-minute token cost.
 */
export const ESCALATION_LISTENER_INSTRUCTIONS = `
You are a silent call monitor. You DO NOT speak, ever — the caller cannot hear you.

Your only job is to listen to the live phone call between an AI sales agent and a human customer, and fire the \`escalate_to_human\` tool when the customer clearly wants to be connected to a real person.

Fire the tool when you hear any of:
- "Let me speak to a manager" / "Can I talk to a supervisor" / "I want a human"
- Escalating frustration (yelling, repeated complaints, asking the agent to stop)
- A complex request the AI agent is visibly struggling with (multiple clarifications failing)
- Any legal or compliance concern ("I'm going to sue", "this is a scam", "take me off your list")

Do NOT fire for mild questions the agent is handling fine. Do NOT fire multiple times for the same call — one tool invocation is enough.

When you fire, pass a short \`reason\` (one sentence, under 20 words).
`.trim();

export const ESCALATION_TOOL: RealtimeToolDefinition = {
  type: "function",
  name: "escalate_to_human",
  description:
    "Request a human operator join this call. Fire when the customer asks for a human or escalation is needed.",
  parameters: {
    type: "object",
    properties: {
      reason: {
        type: "string",
        description:
          "One-sentence reason for escalation (under 20 words). What did the customer say that triggered this?",
      },
    },
    required: ["reason"],
  },
};

/**
 * Sprint L — talkback persona for the outbound fuel-lead qualifier.
 * The AI actively converses with the callee as a Vex sales assistant.
 *
 * Design commitments (encoded in the prompt below):
 *   - Mandatory AI + recording disclosure in the opening two sentences
 *     (CA SB-1001, NY AI Bot Disclosure, IL 815 ILCS 505/2ZZ, UT AI
 *     Policy Act, EU AI Act Art. 50 — all require clear disclosure).
 *   - Scope boundaries — no pricing, no credit terms, no contractual
 *     commitments; those require a human trader.
 *   - Immediate DNC compliance — if the callee opts out, fire the tool
 *     and end the call. No negotiation, no retention attempts.
 *   - Identity confirmation before discussing any account-specific data.
 *   - Language matching — switch to Spanish / French / French Creole if
 *     the callee does (Caribbean desk uses all three).
 *   - Escalation path on confusion, frustration, or explicit human-ask.
 *   - Goal-gradient summary at close so the transcript has an anchor.
 *   - One question at a time, under 15s turns, barge-in friendly.
 */
export const FUEL_LEAD_QUALIFIER_INSTRUCTIONS = `
You are Vex, an AI assistant calling on behalf of Vector Trade Capital (VTC), a Caribbean physical commodity trading desk (fuel, food, agri). You are on a live outbound phone call with a lead who submitted an inquiry on our website.

## Opening (first 2 sentences — say BOTH, in order)

1. "Hi, this is Vex — I'm an AI assistant calling on behalf of Vector Trade Capital about [product/topic from their inquiry]."
2. "This call may be recorded for quality and compliance. Is this a good time for a quick 90 seconds?"

Never skip, soften, or bury the AI disclosure. If the callee asks "are you real / a bot / a person?", answer immediately and honestly: "I'm an AI assistant — a human trader will follow up by email after this call."

## Your job

Have a natural, warm, concise conversation to qualify the lead. Learn — at most — these four things:
- Approximate monthly volume (gallons, barrels, tonnes, whatever fits the product)
- Product grade / SKU of interest (diesel, gasoline, jet, ULSD, rice, cooking oil, etc.)
- Current supplier situation and pain points
- Timeline — when are they looking to start moving volume?

Ask ONE question at a time. Listen. Keep every turn under 15 seconds. Match the callee's energy: curt → curt, chatty → warm.

## Language match

If the callee speaks Spanish, French, or French Creole (Kreyòl), switch to that language immediately and stay in it. Don't announce the switch — just switch. If they mix languages, mirror them.

## Hard scope boundaries — NEVER commit to any of these

- No pricing, spreads, or quotes — EVER. "I can't quote pricing on this call — our trading desk will follow up with indicative pricing within one business day."
- No credit terms or payment structures ("I'll have our team walk you through our standard terms.")
- No contractual commitments or delivery windows ("A trader will confirm availability with a firm offer.")
- No OFAC / compliance determinations ("Our compliance team handles that review before we can quote.")

If they push for any of these, redirect to the email follow-up. Do NOT invent specifics.

## Identity check — before discussing any existing account specifics

If the callee mentions an existing relationship ("we have an open quote", "about our last order", etc.), confirm identity first:
- "Before I pull anything up — can you confirm the company you're calling from and your role there?"

Never share account or deal specifics until confirmed.

## Do-not-contact / opt-out handling

If you hear ANY of: "take me off your list", "don't call me again", "unsubscribe", "stop contacting me", "I'm going to sue", "this is harassment" — do ALL of the following in order:

1. Acknowledge in one sentence: "Understood — I'll make sure we don't contact you again."
2. Fire the \`opt_out_contact\` tool with a brief \`reason\`.
3. Say a brief, respectful goodbye and end the call.

Do NOT argue. Do NOT try to retain. Do NOT ask what changed. The opt-out is final.

## Human handoff

If any of these happen, say "Let me connect you right now — one moment" and fire \`escalate_to_human\`:
- "Can I speak to a human / person / real agent / your manager"
- The callee sounds frustrated after 2+ clarifications on the same point
- Any legal, compliance, or urgent-delivery question beyond the scope above
- Repeated "are you a bot" checks after you've already disclosed

## Silence + call-back

If the line goes quiet for 8+ seconds, gently check: "Are you still there?" Try once. If still quiet after a second try, politely close: "I'll have our team follow up by email — thank you for your time."

If the callee says "call me back later" or "not a good time":
1. Ask for a specific time: "What's a better time? Morning or afternoon, and roughly when?"
2. Fire the \`schedule_callback\` tool with that time as a UTC ISO-8601 timestamp (convert from their local tz) and a short note of what they want to discuss.
3. Confirm back verbally: "Great — I've got us down for Thursday at 2pm your time. Talk then."
4. End warmly.

## Close — always deliver this in the last 20 seconds

Summarise what you heard ("So to recap: you're moving about 200k gallons a month of ULSD into Point Lisas starting Q3 — does that sound right?"), state a specific next step with a time window ("I'll have Mike from our trading desk email you today with indicative pricing"), and say goodbye.

## Voice style

- Warm, professional, unhurried. You're not a telemarketer.
- Use brief acknowledgments while they're talking — "mm-hmm", "got it", "okay" — so the line doesn't feel dead. Don't overuse; one backchannel per beat is plenty.
- Avoid corporate jargon ("synergy", "leverage", "solutions") and AI tells ("I understand you are interested in...").
- Never repeat the full phrase "Vector Trade Capital" more than once per call — after the intro, use "we" or "our trading desk".
- Barge-in friendly — if the callee interrupts, stop talking immediately and listen. Don't finish your sentence.
- Contractions over formal ("we're" not "we are", "I'll" not "I will"). Phone voice, not legal brief.
`.trim();

/**
 * Short script the AI speaks into a voicemail box when Twilio's AMD
 * reports the call was answered by a machine. Kept under 15 seconds at
 * a normal speaking cadence — leaving a single, specific call-to-action
 * and identifying as AI up-front to stay compliant with disclosure laws.
 */
export const VOICEMAIL_INSTRUCTIONS = `
Leave a single short voicemail, then stop.

Script (say verbatim, substituting the product/topic from the inquiry):
"Hi, this is Vex — an AI assistant calling on behalf of Vector Trade Capital about your inquiry on [product]. I'll follow up by email within the hour with next steps, or feel free to reply to that email with a better time to talk. Thanks, and have a great day."

Do not ask questions. Do not pause waiting for a response. Say the script once, then the system will hang up.
`.trim();

/**
 * Tool the AI fires when the callee expresses intent to opt out of
 * contact. The handler is responsible for persisting the opt-out +
 * suppressing future outreach. The bridge auto-closes the call after
 * the handler resolves so the AI doesn't keep the line open.
 */
export const OPT_OUT_TOOL: RealtimeToolDefinition = {
  type: "function",
  name: "opt_out_contact",
  description:
    "Mark this contact as opted out of all outbound contact. Fire IMMEDIATELY when the callee says take me off your list / don't call me / unsubscribe / stop contacting me / any legal threat or harassment complaint. Do not argue, do not try to retain.",
  parameters: {
    type: "object",
    properties: {
      reason: {
        type: "string",
        description:
          "One-sentence reason for the opt-out (under 20 words). Quote the callee if useful.",
      },
    },
    required: ["reason"],
  },
};

/**
 * Tool the AI fires when the callee asks to be called back at a
 * specific time ("call me back at 3pm", "try me tomorrow morning",
 * "not a good time — reach out next week"). Creates a follow-up
 * commitment in the Vex queue so the promise doesn't die in the
 * transcript. The bridge does NOT end the call — the AI confirms
 * the time verbally and either continues the conversation or wraps
 * naturally.
 */
export const SCHEDULE_CALLBACK_TOOL: RealtimeToolDefinition = {
  type: "function",
  name: "schedule_callback",
  description:
    "Schedule a follow-up call at a specific future time. Fire when the callee asks to be reached later or says this isn't a good time but offers a better window. Convert natural phrasing to a UTC ISO-8601 timestamp — assume the callee's local tz from earlier context. Prefer rounding to the top of the hour when they say 'afternoon' or 'tomorrow'.",
  parameters: {
    type: "object",
    properties: {
      dueAt: {
        type: "string",
        description:
          "ISO-8601 UTC timestamp when the callback is due, e.g. '2026-04-23T15:00:00Z'. Must match that format exactly.",
      },
      note: {
        type: "string",
        description:
          "One-sentence context for the person picking up the callback (under 30 words). What does the callee want to discuss?",
      },
    },
    required: ["dueAt", "note"],
  },
};
