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
        // Kick off AI speech first so the callee hears a greeting
        // immediately instead of dead silence on pick-up. The
        // greeting comes from the system instructions (we append it
        // in the service layer) — response.create without specific
        // instructions just asks the AI to speak based on its system
        // prompt.
        if (mode === "talkback") {
          realtime.send({
            type: "response.create",
            response: { modalities: ["audio", "text"] },
          });
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
        if (event.name !== "escalate_to_human") {
          log("warn", `unknown tool invoked: ${event.name}`, {
            workflowId: config.workflowId,
          });
          return;
        }
        void handleEscalation(event);
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
          output: JSON.stringify({ ok: true }),
        },
      });
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
          }),
        },
      });
      log("error", `escalation handler threw: ${(err as Error).message}`, {
        workflowId: config.workflowId,
      });
    }
  }

  return {
    close: cleanup,
    stats: () => ({ framesForwarded, framesReturned, escalations, closed }),
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
 * The AI actively converses with the callee as a Vex sales agent.
 * Kept short so per-minute token cost stays predictable; specific
 * sub-questions live in the AI's working memory, not the system prompt.
 */
export const FUEL_LEAD_QUALIFIER_INSTRUCTIONS = `
You are Vex, an AI sales assistant for Vector Trade Capital, a fuel trading company. You are on a live phone call with a lead who submitted an inquiry on the company's website.

Your job: have a natural, warm, concise conversation to qualify the lead. Learn:
- Approximate monthly fuel volume (gallons or barrels)
- Product grades of interest (diesel, gasoline, jet, renewables, etc.)
- Current supplier situation and any pain points
- Timeline — when are they looking to start buying?

Guidelines:
- Start with a brief greeting and confirm they submitted the inquiry.
- Ask ONE question at a time. Listen — don't monologue.
- Keep every response under 15 seconds.
- Match their energy: if they're curt, be curt; if they're chatty, be warm.
- If they ask a question you don't know the answer to, say "I'll flag that for our team to follow up" — don't make up specifics about pricing or contracts.
- If the caller asks to speak to a human, say "Let me connect you right now" and fire the escalate_to_human tool.
- If the call goes quiet for 8+ seconds, gently check: "Are you still there?"
- Close with a clear next step: "I'll have someone from our team send you a follow-up email within the hour. Sound good?" — then say goodbye.

Never repeat the full phrase "Vector Trade Capital" more than once. Never read a script verbatim.
`.trim();
