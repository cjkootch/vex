import type { IncomingMessage, Server as HttpServer } from "node:http";
import type { Socket } from "node:net";
import { URL } from "node:url";
import { WebSocket, WebSocketServer } from "ws";
import {
  ESCALATION_LISTENER_INSTRUCTIONS,
  ESCALATION_TOOL,
  startVoiceBridge,
  type RealtimeClientEvent,
  type RealtimeServerEvent,
  type RealtimeTransport,
  type TwilioStreamMessage,
  type TwilioStreamTransport,
  type VoiceBridgeHandle,
} from "@vex/integrations";

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
  /** Optional instructions override — defaults to the canonical listener prompt. */
  instructions?: string;
  onEscalate: (args: {
    workflowId: string;
    tenantId: string;
    callId: string;
    reason: string;
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
    server.on("upgrade", (req, socket, head) => {
      const url = (() => {
        try {
          return new URL(req.url ?? "/", "http://localhost");
        } catch {
          return null;
        }
      })();
      if (!url || url.pathname !== "/calls/twilio/stream") return;

      if (!this.config.enabled) {
        socket.write("HTTP/1.1 503 Service Unavailable\r\n\r\n");
        socket.destroy();
        return;
      }

      const wf = url.searchParams.get("wf");
      const tenant = url.searchParams.get("tenant");
      if (!wf || !tenant) {
        socket.write("HTTP/1.1 400 Bad Request\r\n\r\n");
        socket.destroy();
        return;
      }

      this.wss.handleUpgrade(req, socket as Socket, head, (ws) => {
        void this.handleConnection(ws, { workflowId: wf, tenantId: tenant }, req).catch(
          (err) => {
            this.config.log("error", `voice stream handle failed: ${(err as Error).message}`, {
              workflowId: wf,
            });
            try {
              ws.close(1011, "server_error");
            } catch {
              /* already closed */
            }
          },
        );
      });
    });
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
    args: { workflowId: string; tenantId: string },
    _req: IncomingMessage,
  ): Promise<void> {
    const twilio = wrapTwilioWs(ws);
    const realtime = await (this.config.openaiFactory
      ? this.config.openaiFactory(this.config.openaiApiKey, this.config.model)
      : openRealtimeSession(this.config.openaiApiKey, this.config.model));

    this.config.log("info", "voice bridge upgrade accepted", {
      workflowId: args.workflowId,
    });

    const handle = startVoiceBridge(twilio, realtime, {
      workflowId: args.workflowId,
      tenantId: args.tenantId,
      instructions: this.config.instructions ?? ESCALATION_LISTENER_INSTRUCTIONS,
      tools: [ESCALATION_TOOL],
      onEscalate: async (payload) => {
        await this.config.onEscalate(payload);
      },
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
function wrapTwilioWs(ws: WebSocket): TwilioStreamTransport {
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
