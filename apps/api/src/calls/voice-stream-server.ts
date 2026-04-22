import type { IncomingMessage, Server as HttpServer } from "node:http";
import type { Socket } from "node:net";
import { URL } from "node:url";
import { WebSocket, WebSocketServer, type RawData } from "ws";
import {
  ESCALATION_LISTENER_INSTRUCTIONS,
  ESCALATION_TOOL,
  FUEL_LEAD_QUALIFIER_INSTRUCTIONS,
  OPT_OUT_TOOL,
  SCHEDULE_CALLBACK_TOOL,
  startVoiceBridge,
  type RealtimeClientEvent,
  type RealtimeServerEvent,
  type RealtimeTransport,
  type RealtimeVoice,
  type TwilioStreamMessage,
  type TwilioStreamTransport,
  type VoiceBridgeHandle,
} from "@vex/integrations";

/** Supported WS paths. "listen" = Sprint K escalation monitor; "talkback" = Sprint L AI conversation. */
type StreamMode = "listen" | "talkback";
const STREAM_PATHS: Record<string, StreamMode> = {
  "/calls/twilio/stream": "listen",
  "/calls/twilio/ai-stream": "talkback",
};

/**
 * Sprint K — WebSocket server that bridges Twilio Media Streams
 * (callee-leg audio forks) into OpenAI Realtime listener sessions.
 *
 * Mounted on the Nest/Fastify raw HTTP server in `noServer` mode so
 * we can route based on URL without colliding with HTTP handlers.
 * Activates only when `config.enabled === true` — Twilio upgrade
 * requests hit a 503 close otherwise so the call continues cleanly
 * via the conference-only TwiML.
 *
 * Per-connection flow:
 *   1. Parse `wf` + `tenant` query params (fail-closed: 4400 close)
 *   2. Open an OpenAI Realtime WS with `?model={model}` + bearer auth
 *   3. Start a VoiceBridge; on escalation, call `onEscalate` (which
 *      the caller wires to CallsService.requestHumanBackup).
 *
 * No signature verification today — Twilio does not sign Media
 * Stream upgrades the same way it signs HTTP webhooks. Out-of-band
 * security is the wss:// TLS + the short-lived call SIDs. Real
 * protection lives in Sprint L (per-call token minted in the TwiML).
 */
export interface VoiceStreamServerConfig {
  enabled: boolean;
  openaiApiKey: string;
  model: string;
  /** Voice preset for talkback mode (ignored in listen mode). */
  voice?: RealtimeVoice;
  /** Optional server-VAD tuning — overrides the bridge defaults. */
  turnDetection?: {
    threshold?: number;
    prefixPaddingMs?: number;
    silenceDurationMs?: number;
  };
  /** Optional instructions override — defaults to the canonical listener prompt. */
  instructions?: string;
  onEscalate: (args: {
    workflowId: string;
    tenantId: string;
    callId: string;
    reason: string;
  }) => Promise<void>;
  /**
   * Invoked when the AI fires the `opt_out_contact` tool mid-call.
   * Handler should persist `contact.opt_out` so future outreach is
   * suppressed. If omitted, the bridge still fires the tool and ends
   * the call — just without the DB write (the audit trail lives in
   * the transcript + agent-run).
   */
  onDoNotContact?: (args: {
    workflowId: string;
    tenantId: string;
    callId: string;
    reason: string;
  }) => Promise<void>;
  /**
   * Invoked when the AI fires `schedule_callback`. Handler should
   * create a `follow_up.schedule` approval / DB row so the callback
   * commitment survives the transcript. Tool fires unconditionally
   * when registered (below); bridge keeps the call open regardless.
   */
  onScheduleCallback?: (args: {
    workflowId: string;
    tenantId: string;
    callId: string;
    dueAt: string;
    note: string;
  }) => Promise<void>;
  log: (level: "info" | "warn" | "error", msg: string, meta?: object) => void;
  /** Injection point for tests — returns a fake duplex transport. */
  openaiFactory?: (
    apiKey: string,
    model: string,
  ) => Promise<RealtimeTransport>;
}

export class VoiceStreamServer {
  private readonly wss: WebSocketServer;
  private readonly handles = new Set<VoiceBridgeHandle>();

  constructor(private readonly config: VoiceStreamServerConfig) {
    this.wss = new WebSocketServer({ noServer: true });
  }

  /**
   * Attach to a raw HTTP server's `upgrade` event. The handler only
   * consumes upgrades whose path matches /calls/twilio/stream — all
   * other upgrade URLs are left for other listeners.
   */
  attach(server: HttpServer): void {
    this.config.log("info", "voice stream server attaching", {
      paths: Object.keys(STREAM_PATHS),
      enabled: this.config.enabled,
    });
    server.on("upgrade", (req, socket, head) => {
      const url = (() => {
        try {
          return new URL(req.url ?? "/", "http://localhost");
        } catch {
          return null;
        }
      })();
      this.config.log("info", "voice stream upgrade received", {
        url: req.url ?? null,
        pathname: url?.pathname ?? null,
      });
      const streamMode = url ? STREAM_PATHS[url.pathname] : undefined;
      if (!url || !streamMode) return;

      if (!this.config.enabled) {
        socket.write("HTTP/1.1 503 Service Unavailable\r\n\r\n");
        socket.destroy();
        return;
      }

      // Twilio's `<Connect><Stream>` drops URL query strings, so
      // tenant/wf arrive only in the "start" message's
      // customParameters. Accept the upgrade and buffer frames until
      // start lands, then kick off the bridge.
      this.wss.handleUpgrade(req, socket as Socket, head, (ws) => {
        this.waitForStartThenBridge(ws, streamMode, req);
      });
    });
  }

  private waitForStartThenBridge(
    ws: WebSocket,
    mode: StreamMode,
    req: IncomingMessage,
  ): void {
    const buffered: TwilioStreamMessage[] = [];
    const onEarly = (data: RawData): void => {
      try {
        const parsed = JSON.parse(data.toString()) as TwilioStreamMessage;
        buffered.push(parsed);
        if (parsed.event !== "start") return;

        const params = parsed.start.customParameters ?? {};
        const tenant = params["tenant"];
        if (!tenant) {
          this.config.log("warn", "voice stream missing tenant param", {
            callSid: parsed.start.callSid,
          });
          try {
            ws.close(4400, "missing_tenant");
          } catch {
            /* already closed */
          }
          return;
        }
        const wf = params["wf"] ?? "demo";
        const customInstructions = params["instructions"];

        ws.off("message", onEarly);

        void this.handleConnection(
          ws,
          {
            workflowId: wf,
            tenantId: tenant,
            mode,
            ...(customInstructions
              ? { instructions: customInstructions }
              : {}),
          },
          req,
          buffered,
        ).catch((err) => {
          this.config.log(
            "error",
            `voice stream handle failed: ${(err as Error).message}`,
            { workflowId: wf },
          );
          try {
            ws.close(1011, "server_error");
          } catch {
            /* already closed */
          }
        });
      } catch {
        /* non-JSON frame — drop */
      }
    };
    ws.on("message", onEarly);
  }

  /** Tear down all active bridges (called from the API shutdown hook). */
  close(): void {
    for (const h of this.handles) {
      try {
        h.close();
      } catch {
        /* already torn down */
      }
    }
    this.handles.clear();
    this.wss.close();
  }

  private async handleConnection(
    ws: WebSocket,
    args: {
      workflowId: string;
      tenantId: string;
      mode: StreamMode;
      instructions?: string;
    },
    _req: IncomingMessage,
    replay: TwilioStreamMessage[] = [],
  ): Promise<void> {
    const twilio = wrapTwilioWs(ws, replay);
    const realtime = await (this.config.openaiFactory
      ? this.config.openaiFactory(this.config.openaiApiKey, this.config.model)
      : openRealtimeSession(this.config.openaiApiKey, this.config.model));

    this.config.log("info", "voice bridge upgrade accepted", {
      workflowId: args.workflowId,
      mode: args.mode,
    });

    const instructions =
      args.instructions ??
      (args.mode === "talkback"
        ? FUEL_LEAD_QUALIFIER_INSTRUCTIONS
        : (this.config.instructions ?? ESCALATION_LISTENER_INSTRUCTIONS));

    // Tools registered per mode + which handlers are wired. Escalation
    // always. Opt-out whenever a handler is configured OR we're in
    // talkback mode (the prompt relies on the tool being callable).
    // Schedule-callback only when the handler is wired — the AI has a
    // viable fallback (acknowledge verbally, let post-call parse the
    // transcript) when it's not.
    const tools: typeof ESCALATION_TOOL[] = [ESCALATION_TOOL];
    if (args.mode === "talkback" || this.config.onDoNotContact) {
      tools.push(OPT_OUT_TOOL);
    }
    if (this.config.onScheduleCallback) {
      tools.push(SCHEDULE_CALLBACK_TOOL);
    }

    const handle = startVoiceBridge(twilio, realtime, {
      workflowId: args.workflowId,
      tenantId: args.tenantId,
      instructions,
      tools,
      mode: args.mode,
      ...(this.config.voice ? { voice: this.config.voice } : {}),
      ...(this.config.turnDetection
        ? { turnDetection: this.config.turnDetection }
        : {}),
      onEscalate: async (payload) => {
        await this.config.onEscalate(payload);
      },
      ...(this.config.onDoNotContact
        ? {
            onDoNotContact: async (payload) => {
              await this.config.onDoNotContact!(payload);
            },
          }
        : {}),
      ...(this.config.onScheduleCallback
        ? {
            onScheduleCallback: async (payload) => {
              await this.config.onScheduleCallback!(payload);
            },
          }
        : {}),
      log: this.config.log,
    });
    this.handles.add(handle);

    const untrack = (): void => {
      this.handles.delete(handle);
    };
    ws.once("close", untrack);
  }
}

/** Wrap a Node `ws` WebSocket into the transport interface the bridge expects. */
function wrapTwilioWs(
  ws: WebSocket,
  replay: TwilioStreamMessage[] = [],
): TwilioStreamTransport {
  const messageHandlers: ((m: TwilioStreamMessage) => void)[] = [];
  const closeHandlers: ((r?: string) => void)[] = [];
  ws.on("message", (data: Buffer) => {
    try {
      const parsed = JSON.parse(data.toString("utf8")) as TwilioStreamMessage;
      for (const h of messageHandlers) h(parsed);
    } catch {
      /* Twilio streams are always JSON — drop malformed frames. */
    }
  });
  ws.on("close", (code: number, reason: Buffer) => {
    for (const h of closeHandlers) h(reason?.toString("utf8") ?? String(code));
  });
  ws.on("error", () => {
    for (const h of closeHandlers) h("ws_error");
  });
  return {
    onMessage(h) {
      // Replay any frames received before the bridge was started
      // (notably the "start" event that holds streamSid).
      for (const m of replay) h(m);
      messageHandlers.push(h);
    },
    onClose(h) {
      closeHandlers.push(h);
    },
    send(msg) {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
    },
    close(code, reason) {
      if (
        ws.readyState === WebSocket.OPEN ||
        ws.readyState === WebSocket.CONNECTING
      ) {
        ws.close(code, reason);
      }
    },
  };
}

/**
 * Open an OpenAI Realtime WebSocket session. Returns a duplex
 * transport. Exposed for testing via `openaiFactory` override.
 */
async function openRealtimeSession(
  apiKey: string,
  model: string,
): Promise<RealtimeTransport> {
  const url = `wss://api.openai.com/v1/realtime?model=${encodeURIComponent(model)}`;
  const ws = new WebSocket(url, {
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "OpenAI-Beta": "realtime=v1",
    },
  });
  await new Promise<void>((resolve, reject) => {
    ws.once("open", () => resolve());
    ws.once("error", (err: Error) => reject(err));
  });

  const eventHandlers: ((e: RealtimeServerEvent) => void)[] = [];
  const closeHandlers: ((r?: string) => void)[] = [];
  ws.on("message", (data: Buffer) => {
    try {
      const parsed = JSON.parse(data.toString("utf8")) as RealtimeServerEvent;
      for (const h of eventHandlers) h(parsed);
    } catch {
      /* drop unparseable frames — the protocol is strict JSON */
    }
  });
  ws.on("close", (code: number, reason: Buffer) => {
    for (const h of closeHandlers) h(reason?.toString("utf8") ?? String(code));
  });
  ws.on("error", () => {
    for (const h of closeHandlers) h("ws_error");
  });

  return {
    onEvent(h) {
      eventHandlers.push(h);
    },
    onClose(h) {
      closeHandlers.push(h);
    },
    send(event: RealtimeClientEvent) {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(event));
    },
    close(code, reason) {
      if (
        ws.readyState === WebSocket.OPEN ||
        ws.readyState === WebSocket.CONNECTING
      ) {
        ws.close(code, reason);
      }
    },
  };
}
