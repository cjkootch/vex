import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  startVoiceBridge,
  type RealtimeClientEvent,
  type RealtimeServerEvent,
  type RealtimeTransport,
  type TwilioStreamMessage,
  type TwilioStreamTransport,
} from "./voice-bridge.js";

/**
 * Fake transports — capture outbound messages + expose handler hooks
 * so tests can simulate inbound events from either side. No sockets.
 */
function makeFakeTwilio(): TwilioStreamTransport & {
  emit: (msg: TwilioStreamMessage) => void;
  emitClose: (reason?: string) => void;
  sent: TwilioStreamMessage[];
  closed: boolean;
} {
  const sent: TwilioStreamMessage[] = [];
  let msgHandler: ((m: TwilioStreamMessage) => void) | null = null;
  let closeHandler: ((r?: string) => void) | null = null;
  return {
    sent,
    closed: false,
    onMessage(h) {
      msgHandler = h;
    },
    onClose(h) {
      closeHandler = h;
    },
    send(m) {
      sent.push(m);
    },
    close() {
      this.closed = true;
    },
    emit(m) {
      if (msgHandler) msgHandler(m);
    },
    emitClose(r) {
      if (closeHandler) closeHandler(r);
    },
  };
}

function makeFakeRealtime(): RealtimeTransport & {
  emit: (e: RealtimeServerEvent) => void;
  emitClose: (reason?: string) => void;
  sent: RealtimeClientEvent[];
  closed: boolean;
} {
  const sent: RealtimeClientEvent[] = [];
  let eventHandler: ((e: RealtimeServerEvent) => void) | null = null;
  let closeHandler: ((r?: string) => void) | null = null;
  return {
    sent,
    closed: false,
    onEvent(h) {
      eventHandler = h;
    },
    onClose(h) {
      closeHandler = h;
    },
    send(e) {
      sent.push(e);
    },
    close() {
      this.closed = true;
    },
    emit(e) {
      if (eventHandler) eventHandler(e);
    },
    emitClose(r) {
      if (closeHandler) closeHandler(r);
    },
  };
}

const START_MSG: TwilioStreamMessage = {
  event: "start",
  streamSid: "MZtest",
  start: {
    streamSid: "MZtest",
    accountSid: "ACtest",
    callSid: "CAtest",
    tracks: ["inbound"],
    mediaFormat: { encoding: "audio/x-mulaw", sampleRate: 8000, channels: 1 },
  },
};

function mediaFrame(i: number): TwilioStreamMessage {
  return {
    event: "media",
    streamSid: "MZtest",
    media: {
      track: "inbound",
      chunk: String(i),
      timestamp: String(i * 20),
      payload: Buffer.from([i, i + 1, i + 2]).toString("base64"),
    },
  };
}

type EscalateArgs = {
  reason: string;
  workflowId: string;
  tenantId: string;
  callId: string;
};
type EscalateFn = (args: EscalateArgs) => Promise<void> | void;

describe("startVoiceBridge", () => {
  let onEscalate: ReturnType<typeof vi.fn> & EscalateFn;

  beforeEach(() => {
    onEscalate = vi
      .fn<[EscalateArgs], Promise<void>>()
      .mockResolvedValue(undefined) as ReturnType<typeof vi.fn> & EscalateFn;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("sends a session.update configuring g711_ulaw + tools on Twilio start", () => {
    const twilio = makeFakeTwilio();
    const realtime = makeFakeRealtime();
    startVoiceBridge(twilio, realtime, {
      workflowId: "wf-1",
      tenantId: "t-1",
      instructions: "be silent",
      tools: [
        {
          type: "function",
          name: "escalate_to_human",
          description: "escalate",
          parameters: { type: "object", properties: {} },
        },
      ],
      onEscalate,
    });

    twilio.emit(START_MSG);

    expect(realtime.sent).toHaveLength(1);
    const first = realtime.sent[0]!;
    expect(first.type).toBe("session.update");
    if (first.type !== "session.update") throw new Error("unreachable");
    expect(first.session.input_audio_format).toBe("g711_ulaw");
    expect(first.session.output_audio_format).toBe("g711_ulaw");
    expect(first.session.modalities).toEqual(["text"]);
    expect(first.session.tool_choice).toBe("auto");
    expect(first.session.tools?.[0]?.name).toBe("escalate_to_human");
  });

  it("forwards Twilio media frames as input_audio_buffer.append events", () => {
    const twilio = makeFakeTwilio();
    const realtime = makeFakeRealtime();
    const handle = startVoiceBridge(twilio, realtime, {
      workflowId: "wf-1",
      tenantId: "t-1",
      instructions: "",
      tools: [],
      onEscalate,
    });

    twilio.emit(START_MSG);
    twilio.emit(mediaFrame(1));
    twilio.emit(mediaFrame(2));
    twilio.emit(mediaFrame(3));

    const appends = realtime.sent.filter(
      (e) => e.type === "input_audio_buffer.append",
    );
    expect(appends).toHaveLength(3);
    expect(handle.stats().framesForwarded).toBe(3);
  });

  it("drops media frames that arrive before start (connected-only phase)", () => {
    const twilio = makeFakeTwilio();
    const realtime = makeFakeRealtime();
    startVoiceBridge(twilio, realtime, {
      workflowId: "wf-1",
      tenantId: "t-1",
      instructions: "",
      tools: [],
      onEscalate,
    });

    twilio.emit({ event: "connected", protocol: "Call", version: "1.0.0" });
    twilio.emit(mediaFrame(1));
    // no start → nothing should have been sent to realtime yet.
    expect(realtime.sent).toHaveLength(0);
  });

  it("on escalate_to_human tool: invokes onEscalate with the parsed reason + function_call_output echo", async () => {
    const twilio = makeFakeTwilio();
    const realtime = makeFakeRealtime();
    startVoiceBridge(twilio, realtime, {
      workflowId: "wf-1",
      tenantId: "t-1",
      instructions: "",
      tools: [],
      onEscalate,
    });
    twilio.emit(START_MSG);
    realtime.emit({
      type: "response.function_call_arguments.done",
      name: "escalate_to_human",
      call_id: "call-42",
      arguments: JSON.stringify({ reason: "caller asked for a supervisor" }),
      response_id: "resp-1",
    });

    // onEscalate is async — yield once so the handler's awaits complete.
    await new Promise((r) => setImmediate(r));

    expect(onEscalate).toHaveBeenCalledWith({
      reason: "caller asked for a supervisor",
      workflowId: "wf-1",
      tenantId: "t-1",
      callId: "CAtest",
    });
    const output = realtime.sent.find(
      (e) => e.type === "conversation.item.create",
    );
    expect(output).toBeDefined();
    if (output?.type !== "conversation.item.create") {
      throw new Error("unreachable");
    }
    expect(output.item.type).toBe("function_call_output");
    expect(output.item.call_id).toBe("call-42");
    expect(JSON.parse(output.item.output)).toEqual({ ok: true });
  });

  it("tolerates malformed tool arguments — defaults reason string + still invokes handler", async () => {
    const twilio = makeFakeTwilio();
    const realtime = makeFakeRealtime();
    startVoiceBridge(twilio, realtime, {
      workflowId: "wf-1",
      tenantId: "t-1",
      instructions: "",
      tools: [],
      onEscalate,
    });
    twilio.emit(START_MSG);
    realtime.emit({
      type: "response.function_call_arguments.done",
      name: "escalate_to_human",
      call_id: "call-43",
      arguments: "not-json{",
      response_id: "resp-2",
    });
    await new Promise((r) => setImmediate(r));
    expect(onEscalate).toHaveBeenCalledWith(
      expect.objectContaining({
        reason: "ai-detected escalation",
        workflowId: "wf-1",
      }),
    );
  });

  it("returns an error envelope to the session when onEscalate throws", async () => {
    const twilio = makeFakeTwilio();
    const realtime = makeFakeRealtime();
    const failing = vi
      .fn<[EscalateArgs], Promise<void>>()
      .mockRejectedValue(new Error("backup_service_down"));
    startVoiceBridge(twilio, realtime, {
      workflowId: "wf-1",
      tenantId: "t-1",
      instructions: "",
      tools: [],
      onEscalate: failing,
    });
    twilio.emit(START_MSG);
    realtime.emit({
      type: "response.function_call_arguments.done",
      name: "escalate_to_human",
      call_id: "call-44",
      arguments: "{}",
      response_id: "resp-3",
    });
    await new Promise((r) => setImmediate(r));
    const output = realtime.sent.find(
      (e) => e.type === "conversation.item.create",
    );
    if (output?.type !== "conversation.item.create") {
      throw new Error("unreachable");
    }
    expect(JSON.parse(output.item.output)).toEqual({
      ok: false,
      error: "backup_service_down",
    });
  });

  it("ignores unknown tools so a schema drift doesn't crash the bridge", async () => {
    const twilio = makeFakeTwilio();
    const realtime = makeFakeRealtime();
    startVoiceBridge(twilio, realtime, {
      workflowId: "wf-1",
      tenantId: "t-1",
      instructions: "",
      tools: [],
      onEscalate,
    });
    twilio.emit(START_MSG);
    realtime.emit({
      type: "response.function_call_arguments.done",
      name: "some_new_tool",
      call_id: "call-45",
      arguments: "{}",
      response_id: "resp-4",
    });
    await new Promise((r) => setImmediate(r));
    expect(onEscalate).not.toHaveBeenCalled();
  });

  it("closes both transports on Twilio stop", () => {
    const twilio = makeFakeTwilio();
    const realtime = makeFakeRealtime();
    const handle = startVoiceBridge(twilio, realtime, {
      workflowId: "wf-1",
      tenantId: "t-1",
      instructions: "",
      tools: [],
      onEscalate,
    });
    twilio.emit(START_MSG);
    twilio.emit({
      event: "stop",
      streamSid: "MZtest",
      stop: { accountSid: "ACtest", callSid: "CAtest" },
    });
    expect(twilio.closed).toBe(true);
    expect(realtime.closed).toBe(true);
    expect(handle.stats().closed).toBe(true);
  });

  it("closes both transports when the realtime side drops", () => {
    const twilio = makeFakeTwilio();
    const realtime = makeFakeRealtime();
    startVoiceBridge(twilio, realtime, {
      workflowId: "wf-1",
      tenantId: "t-1",
      instructions: "",
      tools: [],
      onEscalate,
    });
    twilio.emit(START_MSG);
    realtime.emitClose("server-hung-up");
    expect(twilio.closed).toBe(true);
    expect(realtime.closed).toBe(true);
  });

  it("close() is idempotent — double close does not throw", () => {
    const twilio = makeFakeTwilio();
    const realtime = makeFakeRealtime();
    const handle = startVoiceBridge(twilio, realtime, {
      workflowId: "wf-1",
      tenantId: "t-1",
      instructions: "",
      tools: [],
      onEscalate,
    });
    handle.close();
    expect(() => handle.close()).not.toThrow();
  });

  it("surfaces realtime error events through the logger without closing", () => {
    const twilio = makeFakeTwilio();
    const realtime = makeFakeRealtime();
    const log = vi.fn();
    startVoiceBridge(twilio, realtime, {
      workflowId: "wf-1",
      tenantId: "t-1",
      instructions: "",
      tools: [],
      onEscalate,
      log,
    });
    twilio.emit(START_MSG);
    realtime.emit({
      type: "error",
      error: { type: "invalid_request", message: "bad payload" },
    });
    expect(log).toHaveBeenCalledWith(
      "error",
      expect.stringContaining("bad payload"),
      expect.objectContaining({ workflowId: "wf-1" }),
    );
    // Error doesn't tear down — subsequent frames still flow.
    twilio.emit(mediaFrame(9));
    expect(realtime.sent.some((e) => e.type === "input_audio_buffer.append")).toBe(true);
  });
});
