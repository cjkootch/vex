"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { VoiceSessionCard } from "./voice-session-card";

type Status =
  | "idle"
  | "preparing"
  | "connecting"
  | "live"
  | "ending"
  | "processing"
  | "ready"
  | "error";

interface SessionStartResponse {
  session_id: string;
  ephemeral_token: string;
  expires_at: number;
  model: string;
  voice_context_brief: string;
  voice_context_tokens: number;
}

interface TranscriptTurn {
  id: string;
  role: "user" | "assistant";
  text: string;
}

export function VoicePanel() {
  const [status, setStatus] = useState<Status>("idle");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [brief, setBrief] = useState<string | null>(null);
  const [briefTokens, setBriefTokens] = useState<number | null>(null);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [turns, setTurns] = useState<TranscriptTurn[]>([]);
  const [durationSeconds, setDurationSeconds] = useState<number>(0);

  const pcRef = useRef<RTCPeerConnection | null>(null);
  const dcRef = useRef<RTCDataChannel | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const localStreamRef = useRef<MediaStream | null>(null);
  const startedAtRef = useRef<number>(0);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const tearDown = useCallback(() => {
    if (timerRef.current) clearInterval(timerRef.current);
    timerRef.current = null;
    if (dcRef.current) {
      try {
        dcRef.current.close();
      } catch {
        /* noop */
      }
    }
    if (pcRef.current) {
      try {
        pcRef.current.close();
      } catch {
        /* noop */
      }
    }
    localStreamRef.current?.getTracks().forEach((t) => t.stop());
    pcRef.current = null;
    dcRef.current = null;
    localStreamRef.current = null;
  }, []);

  useEffect(() => tearDown, [tearDown]);

  const handleStart = useCallback(async () => {
    setErrorMessage(null);
    setTurns([]);
    setDurationSeconds(0);
    setStatus("preparing");

    let session: SessionStartResponse;
    try {
      const response = await fetch("/api/voice/sessions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      });
      if (!response.ok) throw new Error(`session mint failed (${response.status})`);
      session = (await response.json()) as SessionStartResponse;
    } catch (err) {
      setErrorMessage((err as Error).message);
      setStatus("error");
      return;
    }
    setBrief(session.voice_context_brief);
    setBriefTokens(session.voice_context_tokens);
    setSessionId(session.session_id);

    try {
      setStatus("connecting");
      const pc = new RTCPeerConnection();
      pcRef.current = pc;

      pc.ontrack = (ev) => {
        const [stream] = ev.streams;
        if (audioRef.current && stream) audioRef.current.srcObject = stream;
      };

      const localStream = await navigator.mediaDevices.getUserMedia({ audio: true });
      localStreamRef.current = localStream;
      localStream.getTracks().forEach((t) => pc.addTrack(t, localStream));

      const dc = pc.createDataChannel("oai-events");
      dcRef.current = dc;
      dc.addEventListener("message", (e) => {
        try {
          const msg = JSON.parse(e.data as string) as Record<string, unknown>;
          handleRealtimeEvent(msg, setTurns);
        } catch {
          /* ignore non-JSON frames */
        }
      });

      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);

      const sdpResponse = await fetch(
        `https://api.openai.com/v1/realtime?model=${encodeURIComponent(session.model)}`,
        {
          method: "POST",
          headers: {
            authorization: `Bearer ${session.ephemeral_token}`,
            "content-type": "application/sdp",
          },
          body: offer.sdp ?? "",
        },
      );
      if (!sdpResponse.ok) {
        throw new Error(`realtime SDP handshake failed (${sdpResponse.status})`);
      }
      const answerSdp = await sdpResponse.text();
      await pc.setRemoteDescription({ type: "answer", sdp: answerSdp });

      startedAtRef.current = Date.now();
      timerRef.current = setInterval(() => {
        setDurationSeconds(Math.floor((Date.now() - startedAtRef.current) / 1000));
      }, 1000);
      setStatus("live");
    } catch (err) {
      tearDown();
      setErrorMessage((err as Error).message);
      setStatus("error");
    }
  }, [tearDown]);

  const handleEnd = useCallback(async () => {
    if (!sessionId) return;
    setStatus("ending");
    const duration = Math.max(
      1,
      Math.floor((Date.now() - startedAtRef.current) / 1000),
    );
    const transcriptText = turns
      .map((t) => `${t.role === "user" ? "User" : "Vex"}: ${t.text}`)
      .join("\n")
      .trim();

    tearDown();

    try {
      const response = await fetch(`/api/voice/sessions/${sessionId}/end`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          transcript_text: transcriptText || "(no transcript captured)",
          duration_seconds: duration,
        }),
      });
      if (!response.ok) throw new Error(`end failed (${response.status})`);
      setStatus("processing");
      pollUntilReady(sessionId, () => setStatus("ready"), (msg) => {
        setErrorMessage(msg);
        setStatus("error");
      });
    } catch (err) {
      setErrorMessage((err as Error).message);
      setStatus("error");
    }
  }, [sessionId, turns, tearDown]);

  const disabled = status === "preparing" || status === "connecting" || status === "ending";

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-6 px-8 py-10">
      <header className="flex flex-col gap-2">
        <div className="flex items-baseline justify-between gap-4">
          <h1 className="text-2xl font-semibold tracking-tight text-white">
            Talk to Vex
          </h1>
          <span className="text-xs text-white/50">
            Browser mic · OpenAI Realtime
          </span>
        </div>
        <p className="max-w-2xl text-sm text-white/60">
          Hands-free conversation with Vex through your browser
          microphone. This is <span className="text-white/80">not</span> a
          PSTN call to anyone else — Vex answers, you both speak, and
          turns stream as a live transcript below. Useful when you&rsquo;re
          away from the keyboard and want a quick briefing, a deal
          readout, or to dictate a note.{" "}
          <span className="text-white/40">
            (To dial a contact&rsquo;s phone, use{" "}
            <Link
              href="/app/calls"
              className="text-accent underline-offset-2 hover:underline"
            >
              Calls
            </Link>
            .)
          </span>
        </p>
      </header>

      <section className="rounded-lg border border-line bg-muted/40 p-4">
        <h2 className="text-sm font-semibold text-white/80">
          What Vex knows for this session
        </h2>
        <p className="mt-1 text-xs text-white/50">
          A compact brief of your recent deals, hot leads, and open
          approvals — loaded once when the session starts so Vex can
          answer in context without a round-trip.
        </p>
        <pre className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap text-xs text-white/70">
          {brief ?? "Click Start to load this session's context."}
        </pre>
        {briefTokens != null && (
          <p className="mt-2 text-xs text-white/40">
            {briefTokens.toLocaleString()} tokens · hard cap 10,000
          </p>
        )}
      </section>

      <section className="flex items-center gap-3">
        {status !== "live" && (
          <button
            type="button"
            onClick={handleStart}
            disabled={disabled}
            className="rounded-md bg-white px-4 py-2 text-sm font-medium text-black disabled:opacity-50"
          >
            {status === "ready" || status === "error"
              ? "Start new session"
              : "Start talking"}
          </button>
        )}
        {status === "live" && (
          <button
            type="button"
            onClick={handleEnd}
            className="rounded-md bg-bad/80 px-4 py-2 text-sm font-medium text-white"
          >
            End session
          </button>
        )}
        <StatusLabel status={status} durationSeconds={durationSeconds} />
      </section>

      {errorMessage && (
        <p className="rounded-md border border-bad/60 bg-bad/10 p-3 text-xs text-bad">
          {errorMessage}
        </p>
      )}

      <section className="rounded-lg border border-line bg-muted/40 p-4">
        <h2 className="text-sm font-semibold text-white/80">Live transcript</h2>
        {turns.length === 0 ? (
          <p className="mt-2 text-xs text-white/40">
            Nothing spoken yet. Turns will stream here as you talk with Vex.
          </p>
        ) : (
          <ul className="mt-2 space-y-2 text-sm">
            {turns.map((t) => (
              <li key={t.id} className="flex gap-2">
                <span className="w-12 shrink-0 text-xs uppercase tracking-wider text-white/40">
                  {t.role}
                </span>
                <span className="text-white/80">{t.text}</span>
              </li>
            ))}
          </ul>
        )}
      </section>

      {(status === "processing" || status === "ready") && sessionId && (
        <VoiceSessionCard
          sessionId={sessionId}
          durationSeconds={durationSeconds}
          status={status === "processing" ? "processing" : "processed"}
        />
      )}

      <audio ref={audioRef} autoPlay playsInline aria-hidden />
    </div>
  );
}

function StatusLabel({
  status,
  durationSeconds,
}: {
  status: Status;
  durationSeconds: number;
}) {
  const label: Record<Status, string> = {
    idle: "Idle",
    preparing: "Minting token…",
    connecting: "Connecting…",
    live: `Live · ${durationSeconds}s`,
    ending: "Ending…",
    processing: "Processing transcript…",
    ready: "Summary ready",
    error: "Error",
  };
  return <span className="text-xs text-white/50">{label[status]}</span>;
}

/**
 * Map an OpenAI Realtime data-channel event into our transcript state.
 * We care about two things:
 *   - `conversation.item.created` with role=user and a transcript
 *   - `response.output_item.done` with assistant audio transcript
 * Unknown events are ignored — the channel carries many chatty frames.
 */
function handleRealtimeEvent(
  msg: Record<string, unknown>,
  setTurns: (fn: (prev: TranscriptTurn[]) => TranscriptTurn[]) => void,
): void {
  const type = typeof msg["type"] === "string" ? (msg["type"] as string) : "";
  if (type === "conversation.item.created") {
    const item = msg["item"] as Record<string, unknown> | undefined;
    if (!item) return;
    const role = item["role"] === "user" ? "user" : item["role"] === "assistant" ? "assistant" : null;
    if (!role) return;
    const content = item["content"] as Array<Record<string, unknown>> | undefined;
    const text = content
      ?.map((c) => {
        const t = c["transcript"] ?? c["text"];
        return typeof t === "string" ? t : "";
      })
      .filter(Boolean)
      .join(" ");
    if (!text) return;
    const id = typeof item["id"] === "string" ? (item["id"] as string) : crypto.randomUUID();
    setTurns((prev) => dedupeTurn(prev, { id, role, text }));
    return;
  }
  if (type === "response.audio_transcript.delta") {
    const delta = typeof msg["delta"] === "string" ? (msg["delta"] as string) : "";
    const itemId = typeof msg["item_id"] === "string" ? (msg["item_id"] as string) : "";
    if (!delta || !itemId) return;
    setTurns((prev) => appendDelta(prev, itemId, "assistant", delta));
  }
}

function dedupeTurn(prev: TranscriptTurn[], incoming: TranscriptTurn): TranscriptTurn[] {
  const existing = prev.findIndex((p) => p.id === incoming.id);
  if (existing === -1) return [...prev, incoming];
  const copy = [...prev];
  copy[existing] = incoming;
  return copy;
}

function appendDelta(
  prev: TranscriptTurn[],
  id: string,
  role: TranscriptTurn["role"],
  delta: string,
): TranscriptTurn[] {
  const existing = prev.findIndex((p) => p.id === id);
  if (existing === -1) return [...prev, { id, role, text: delta }];
  const copy = [...prev];
  const turn = copy[existing]!;
  copy[existing] = { ...turn, text: `${turn.text}${delta}` };
  return copy;
}

async function pollUntilReady(
  sessionId: string,
  onReady: () => void,
  onError: (msg: string) => void,
): Promise<void> {
  const started = Date.now();
  const deadline = started + 90_000;
  const poll = async (): Promise<void> => {
    try {
      const response = await fetch(`/api/voice/sessions/${sessionId}`);
      if (response.ok) {
        const body = (await response.json()) as { status?: string };
        if (body.status === "processed") {
          onReady();
          return;
        }
      }
    } catch {
      /* retry */
    }
    if (Date.now() > deadline) {
      onError("Transcript processing timed out. Check the activity log.");
      return;
    }
    setTimeout(() => void poll(), 3000);
  };
  void poll();
}
