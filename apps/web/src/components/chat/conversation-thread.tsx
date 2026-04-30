"use client";

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent,
} from "react";
import Link from "next/link";
import { AnimatePresence, motion } from "framer-motion";
import {
  useVexQuery,
  type HistoryTurn,
  type ManifestEvent,
  type QueryScope,
} from "@/lib/use-vex-query";
import { renderProse } from "@/lib/render-prose";
import { ManifestCanvas } from "@/components/canvas/manifest-canvas";
import { AgentTrace } from "@/components/chat/agent-trace";

export interface ChatTurn {
  id: string;
  role: "user" | "assistant";
  text: string;
  manifest?: ManifestEvent | null;
  /** ISO timestamp the turn was created — scopes the AgentTrace window. */
  createdAt?: string;
}

interface Props {
  turns: ChatTurn[];
  onTurns: (turns: ChatTurn[]) => void;
  /**
   * Sprint T — scoped chat. When set, every query in this thread
   * ships a `scope: {type, id}` field that pins the subject in the
   * evidence pack. Undefined = global-scope (default).
   */
  scope?: QueryScope;
  /**
   * Sprint T — one-shot initial prompt, typically injected via
   * `?ask=...` URL param when deep-linked from a subject page's
   * Ask Vex button. Populates the input on mount so the operator
   * can edit before sending. Empty string / undefined is a no-op.
   */
  initialDraft?: string;
}

export function ConversationThread({ turns, onTurns, scope, initialDraft }: Props) {
  const [input, setInput] = useState(initialDraft ?? "");
  const { text, manifest, isStreaming, wakingUp, error, send } = useVexQuery();
  const bottomRef = useRef<HTMLDivElement | null>(null);
  const initialDraftAppliedRef = useRef<string | undefined>(initialDraft);

  // Voice-input state — mic button next to the Send button records a
  // short clip, POSTs it to /api/voice/transcribe, and drops the text
  // back into the composer. MediaRecorder is gated behind a feature
  // check so unsupported browsers just hide the button.
  const [recording, setRecording] = useState(false);
  const [transcribing, setTranscribing] = useState(false);
  const [voiceError, setVoiceError] = useState<string | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const streamRef = useRef<MediaStream | null>(null);
  const voiceSupported =
    typeof window !== "undefined" &&
    typeof window.MediaRecorder !== "undefined" &&
    typeof navigator !== "undefined" &&
    Boolean(navigator.mediaDevices?.getUserMedia);
  // If a new initialDraft arrives (e.g. operator clicks a different
  // subject's Ask Vex while already on /app/chat), refresh the input
  // once — but don't clobber what they've typed mid-edit.
  useEffect(() => {
    if (initialDraft && initialDraft !== initialDraftAppliedRef.current) {
      setInput(initialDraft);
      initialDraftAppliedRef.current = initialDraft;
    }
  }, [initialDraft]);

  // Stream just finished — append the assistant turn to history.
  useEffect(() => {
    if (!isStreaming && (text || manifest)) {
      const assistantTurn: ChatTurn = {
        id: crypto.randomUUID(),
        role: "assistant",
        text,
        manifest: manifest ?? null,
        createdAt: new Date().toISOString(),
      };
      onTurns([...turns, assistantTurn]);
    }
    // We intentionally only react to isStreaming flipping — turns/onTurns
    // would re-trigger this effect.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isStreaming]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [turns.length, text]);

  const stopMediaStream = useCallback((): void => {
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    recorderRef.current = null;
    chunksRef.current = [];
  }, []);

  useEffect(() => stopMediaStream, [stopMediaStream]);

  async function startRecording(): Promise<void> {
    if (recording || transcribing) return;
    setVoiceError(null);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;
      // webm/opus is the broadest MediaRecorder default; Whisper accepts
      // it directly. We let the browser pick if the hint isn't supported.
      const mime = MediaRecorder.isTypeSupported("audio/webm;codecs=opus")
        ? "audio/webm;codecs=opus"
        : MediaRecorder.isTypeSupported("audio/webm")
          ? "audio/webm"
          : "";
      const recorder = mime
        ? new MediaRecorder(stream, { mimeType: mime })
        : new MediaRecorder(stream);
      recorderRef.current = recorder;
      chunksRef.current = [];
      recorder.ondataavailable = (evt) => {
        if (evt.data && evt.data.size > 0) chunksRef.current.push(evt.data);
      };
      recorder.onstop = () => {
        const type = recorder.mimeType || "audio/webm";
        const blob = new Blob(chunksRef.current, { type });
        stopMediaStream();
        if (blob.size === 0) return;
        void uploadClip(blob);
      };
      recorder.start();
      setRecording(true);
    } catch (err) {
      stopMediaStream();
      setVoiceError(
        err instanceof DOMException && err.name === "NotAllowedError"
          ? "mic permission denied"
          : "couldn’t start recording",
      );
    }
  }

  function stopRecording(): void {
    if (!recorderRef.current || !recording) return;
    setRecording(false);
    setTranscribing(true);
    try {
      recorderRef.current.stop();
    } catch {
      setTranscribing(false);
      stopMediaStream();
    }
  }

  async function uploadClip(blob: Blob): Promise<void> {
    try {
      const ext = blob.type.includes("mp4")
        ? "mp4"
        : blob.type.includes("ogg")
          ? "ogg"
          : "webm";
      const form = new FormData();
      form.append("audio", blob, `clip.${ext}`);
      const res = await fetch("/api/voice/transcribe", {
        method: "POST",
        body: form,
      });
      if (!res.ok) {
        setVoiceError(`transcribe failed (${res.status})`);
        return;
      }
      const json = (await res.json()) as { text?: string };
      const heard = (json.text ?? "").trim();
      if (!heard) {
        setVoiceError("no speech detected");
        return;
      }
      setInput((prev) => (prev ? `${prev} ${heard}` : heard));
    } catch (err) {
      setVoiceError(`transcribe failed: ${(err as Error).message}`);
    } finally {
      setTranscribing(false);
    }
  }

  function handleSubmit(e: FormEvent<HTMLFormElement>): void {
    e.preventDefault();
    submit();
  }

  function handleKey(e: KeyboardEvent<HTMLTextAreaElement>): void {
    if ((e.key === "Enter" && !e.shiftKey) || (e.key === "Enter" && e.metaKey)) {
      e.preventDefault();
      submit();
    }
  }

  function submit(): void {
    const message = input.trim();
    if (!message || isStreaming) return;
    onTurns([
      ...turns,
      {
        id: crypto.randomUUID(),
        role: "user",
        text: message,
        createdAt: new Date().toISOString(),
      },
    ]);
    setInput("");
    // Pass the last 6 turns (user + assistant interleaved) so Claude
    // and the retrieval layer can disambiguate follow-ups like
    // "change this status to won" against the deal mentioned earlier.
    const history: HistoryTurn[] = turns.slice(-6).map((t) => ({
      role: t.role,
      text: t.text,
    }));
    void send(message, history, scope);
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="min-h-0 flex-1 overflow-y-auto px-6 py-4">
        <div className="mx-auto flex max-w-3xl flex-col gap-6">
          {turns.length === 0 && (
            <p className="text-center text-sm text-white/40">
              Ask a question about your accounts, contacts, or campaigns.
            </p>
          )}
          {turns.length > 0 ? (
            <div className="-mb-2 flex justify-end">
              <CopyAsMarkdownButton turns={turns} />
            </div>
          ) : null}
          <AnimatePresence initial={false}>
            {turns.map((turn) => (
              <Turn key={turn.id} turn={turn} />
            ))}
            {isStreaming && (
              <motion.div
                key="streaming"
                layout
                initial={{ opacity: 0, y: 10, scale: 0.98 }}
                animate={{ opacity: 1, y: 0, scale: 1 }}
                exit={{ opacity: 0, y: -6, scale: 0.98 }}
                transition={{ type: "spring", stiffness: 320, damping: 32, mass: 0.8 }}
                className="self-start"
                data-testid="assistant-streaming"
              >
                <div className="rounded-2xl bg-muted/60 px-4 py-3 text-sm text-white/90 shadow-sm shadow-black/10">
                  {wakingUp ? (
                    <span className="text-white/60">
                      API is waking up — one moment…
                    </span>
                  ) : text ? (
                    <>
                      {renderProse(text)}
                      <StreamingCaret />
                    </>
                  ) : (
                    <TypingIndicator />
                  )}
                </div>
                {manifest && (
                  <motion.div
                    initial={{ opacity: 0, y: 4 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ duration: 0.25, ease: "easeOut" }}
                    className="mt-3 inline-flex items-center gap-2 rounded-md border border-line bg-canvas/60 px-2.5 py-1 text-[10px] uppercase tracking-wider text-white/50"
                  >
                    <motion.span
                      className="inline-block h-1.5 w-1.5 rounded-full bg-accent"
                      animate={{ opacity: [0.3, 1, 0.3], scale: [0.9, 1.15, 0.9] }}
                      transition={{ duration: 1.2, repeat: Infinity, ease: "easeInOut" }}
                    />
                    preparing canvas…
                  </motion.div>
                )}
              </motion.div>
            )}
            {error && (
              <motion.p
                key="chat-error"
                initial={{ opacity: 0, x: -8, scale: 0.98 }}
                animate={{ opacity: 1, x: 0, scale: 1 }}
                exit={{ opacity: 0, x: -8, scale: 0.98 }}
                transition={{ type: "spring", stiffness: 380, damping: 30 }}
                className="self-start rounded-md bg-bad/10 px-3 py-2 text-sm text-bad"
              >
                {error}
              </motion.p>
            )}
          </AnimatePresence>
          <div ref={bottomRef} />
        </div>
      </div>

      <form
        onSubmit={handleSubmit}
        className="flex-shrink-0 border-t border-line bg-canvas/95 px-6 py-4 backdrop-blur"
      >
        <div className="mx-auto flex max-w-3xl flex-col gap-1">
          <div className="flex items-end gap-2">
            <textarea
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={handleKey}
              placeholder={
                recording ? "Listening…" : transcribing ? "Transcribing…" : "Ask Vex…"
              }
              rows={1}
              data-testid="chat-input"
              disabled={recording || transcribing}
              className="min-h-[44px] flex-1 resize-none rounded-md border border-line bg-muted/60 px-3 py-2 text-base text-white outline-none focus:border-accent disabled:opacity-70 md:text-sm"
            />
            {voiceSupported && (
              <button
                type="button"
                onClick={recording ? stopRecording : () => void startRecording()}
                disabled={transcribing || isStreaming}
                aria-label={recording ? "Stop recording" : "Start voice input"}
                data-testid="chat-mic"
                className={`flex h-[44px] w-[44px] items-center justify-center rounded-md border text-sm disabled:opacity-30 ${
                  recording
                    ? "border-bad/60 bg-bad/20 text-bad"
                    : "border-line bg-muted/60 text-white/70 hover:text-white"
                }`}
              >
                {transcribing ? (
                  <span className="inline-block h-3 w-3 animate-spin rounded-full border-2 border-white/30 border-t-white" />
                ) : recording ? (
                  <MicStopIcon />
                ) : (
                  <MicIcon />
                )}
              </button>
            )}
            <button
              type="submit"
              disabled={isStreaming || !input.trim() || recording || transcribing}
              className="rounded-md bg-accent px-4 py-2 text-sm font-medium text-white disabled:opacity-30"
            >
              Send
            </button>
          </div>
          {voiceError && (
            <p className="text-xs text-bad" data-testid="chat-mic-error">
              {voiceError}
            </p>
          )}
        </div>
      </form>
    </div>
  );
}

function Turn({ turn }: { turn: ChatTurn }) {
  const isUser = turn.role === "user";
  const common = {
    layout: true,
    initial: { opacity: 0, y: 10, x: isUser ? 8 : -8, scale: 0.98 },
    animate: { opacity: 1, y: 0, x: 0, scale: 1 },
    exit: { opacity: 0, y: -6, scale: 0.98 },
    transition: { type: "spring" as const, stiffness: 340, damping: 30, mass: 0.8 },
  };
  if (isUser) {
    return (
      <motion.div
        {...common}
        className="self-end max-w-[85%] rounded-2xl bg-accent/20 px-4 py-3 text-sm text-white shadow-sm shadow-accent/20"
      >
        {turn.text}
      </motion.div>
    );
  }
  const createdApprovals = turn.manifest?.created_approvals ?? [];
  const rejectedProposals = turn.manifest?.rejected_proposals ?? [];
  return (
    <motion.div
      {...common}
      className="self-start w-full max-w-[85%]"
      data-testid="assistant-turn"
    >
      <div className="rounded-2xl bg-muted/60 px-4 py-3 text-sm text-white/90 shadow-sm shadow-black/10">
        {turn.text ? renderProse(turn.text) : <span className="text-white/40">No response.</span>}
      </div>
      {createdApprovals.length > 0 ? (
        <InlineApprovalChips approvals={createdApprovals} />
      ) : null}
      {rejectedProposals.length > 0 ? (
        <RejectedProposalChips rejected={rejectedProposals} />
      ) : null}
      {turn.createdAt && <AgentTrace since={turn.createdAt} />}
      {turn.manifest && (
        <div className="mt-3" data-testid="manifest-canvas">
          <ManifestCanvas manifest={turn.manifest.manifest} rawAnswer={turn.text} />
        </div>
      )}
    </motion.div>
  );
}

interface ChatApprovalState {
  decision: "pending" | "approved" | "rejected";
  outcome: null | {
    status: "queued" | "applied" | "failed" | "skipped" | "delivered";
    reason: string | null;
  };
  inFlight: boolean;
  error: string | null;
}

interface CreatedApprovalMeta {
  approvalId: string;
  actionType: string;
  tier: string;
  payload?: Record<string, unknown>;
}

/**
 * Inline approve/reject chips rendered directly under an assistant
 * bubble whenever the turn's `created_approvals` is non-empty. Click
 * Approve or Reject → hits the same /api/approvals/:id/approve|reject
 * endpoint the full inbox uses, then polls /api/approvals/:id/outcome
 * on the same cadence as the Decided pane so the operator sees
 * "applied" / "executor failed: <reason>" without leaving the thread.
 */
function InlineApprovalChips({ approvals }: { approvals: CreatedApprovalMeta[] }) {
  const [state, setState] = useState<Record<string, ChatApprovalState>>(() => {
    const init: Record<string, ChatApprovalState> = {};
    for (const a of approvals) {
      init[a.approvalId] = {
        decision: "pending",
        outcome: null,
        inFlight: false,
        error: null,
      };
    }
    return init;
  });

  // Hydrate decision + outcome on mount so that re-entering a chat
  // thread (or refreshing the page) shows each chip's actual server
  // state instead of resetting every approval to "pending". Approvals
  // already decided come back as approved / rejected / auto_approved
  // with whatever outcome the executor (or Resend webhook) has stamped
  // by now. For chips still in flight (approved + non-terminal
  // outcome) we resume polling so the UI keeps catching the eventual
  // delivered / failed signal instead of stranding at "queued" /
  // "sent".
  const approvalIds = approvals.map((a) => a.approvalId).join(",");
  useEffect(() => {
    let cancelled = false;
    type HydratedResponse = {
      approval: {
        decision: "pending" | "approved" | "rejected" | "auto_approved";
      };
      outcome: ChatApprovalState["outcome"];
    };
    async function hydrate(approvalId: string): Promise<void> {
      try {
        const r = await fetch(
          `/api/approvals/${encodeURIComponent(approvalId)}/outcome`,
          { cache: "no-store" },
        );
        if (!r.ok) return;
        const body = (await r.json()) as HydratedResponse;
        if (cancelled) return;
        // auto_approved (T1 chat actions) renders as "approved" so
        // operators see a green pill instead of an unfamiliar enum.
        const decision: ChatApprovalState["decision"] =
          body.approval.decision === "auto_approved"
            ? "approved"
            : body.approval.decision;
        setState((s) => ({
          ...s,
          [approvalId]: {
            ...(s[approvalId] ?? {
              decision: "pending",
              outcome: null,
              inFlight: false,
              error: null,
            }),
            decision,
            outcome: body.outcome ?? null,
          },
        }));
        // Resume polling when the chip is approved but the executor
        // / delivery webhook hasn't reached a terminal state yet.
        const stillWatching =
          decision === "approved" &&
          (!body.outcome ||
            body.outcome.status === "queued" ||
            body.outcome.status === "applied");
        if (stillWatching) void pollOutcome(approvalId);
      } catch {
        /* fail-soft — chip stays at its initial "pending" state */
      }
    }
    for (const a of approvals) void hydrate(a.approvalId);
    return () => {
      cancelled = true;
    };
    // approvalIds is the stable key — the array reference itself
    // changes per-render even when the contents are identical.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [approvalIds]);

  async function decide(
    approvalId: string,
    action: "approve" | "reject",
  ): Promise<void> {
    setState((s) => ({
      ...s,
      [approvalId]: {
        ...(s[approvalId] ?? {
          decision: "pending",
          outcome: null,
          inFlight: false,
          error: null,
        }),
        inFlight: true,
        error: null,
      },
    }));
    try {
      const r = await fetch(
        `/api/approvals/${encodeURIComponent(approvalId)}/${action}`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({}),
        },
      );
      if (!r.ok) {
        // Pull the upstream error body so the operator sees the real
        // Nest/DB message ("approval … already decided", "column …
        // does not exist", etc) instead of a cryptic "HTTP 500".
        const text = await r.text().catch(() => "");
        const hint = text.length > 0 && text.length < 300 ? ` — ${text}` : "";
        throw new Error(`HTTP ${r.status}${hint}`);
      }
      setState((s) => ({
        ...s,
        [approvalId]: {
          decision: action === "approve" ? "approved" : "rejected",
          outcome: null,
          inFlight: false,
          error: null,
        },
      }));
      if (action === "approve") void pollOutcome(approvalId);
    } catch (err) {
      setState((s) => ({
        ...s,
        [approvalId]: {
          ...(s[approvalId] ?? {
            decision: "pending",
            outcome: null,
            inFlight: false,
            error: null,
          }),
          inFlight: false,
          error: (err as Error).message,
        },
      }));
    }
  }

  async function pollOutcome(approvalId: string): Promise<void> {
    // Two-phase poll. Phase 1 races the executor — we want the chip to
    // flip from "queued" → "applied" within seconds of approve. Phase
    // 2 waits on Resend's `email.delivered` webhook (or sms/whatsapp
    // equivalents), which arrives anywhere from ~5s to a couple of
    // minutes later. We back off aggressively so a quiet chip doesn't
    // hammer the API but still catches a late delivery confirmation
    // up to ~10 minutes out. Statuses: applied/failed/skipped end
    // phase 1; only "delivered"/failed/skipped end phase 2.
    const schedule = [
      2_000, 4_000, 6_000, 10_000, 15_000, 20_000, 30_000, 45_000,
      60_000, 90_000, 120_000, 180_000, 240_000,
    ];
    for (const delay of schedule) {
      await new Promise((r) => setTimeout(r, delay));
      try {
        const r = await fetch(
          `/api/approvals/${encodeURIComponent(approvalId)}/outcome`,
          { cache: "no-store" },
        );
        if (!r.ok) continue;
        const body = (await r.json()) as {
          outcome: ChatApprovalState["outcome"];
        };
        if (!body.outcome) continue;
        setState((s) => ({
          ...s,
          [approvalId]: {
            ...(s[approvalId] ?? {
              decision: "approved",
              outcome: null,
              inFlight: false,
              error: null,
            }),
            outcome: body.outcome,
          },
        }));
        // Terminal states — stop polling.
        if (
          body.outcome.status === "delivered" ||
          body.outcome.status === "failed" ||
          body.outcome.status === "skipped"
        ) {
          return;
        }
        // "applied" is interesting but not terminal — keep polling
        // for the delivered signal. "queued" likewise.
      } catch {
        /* keep trying until the schedule runs out */
      }
    }
  }

  // Manual one-shot outcome re-check. Surfaced via the chip's
  // "Refresh" button when polling has timed out (>10min) but the
  // chip is still showing "queued" / "sent". Re-arms polling on
  // approve-but-non-terminal so a Resend webhook arriving after the
  // refresh still flips the pill.
  async function refreshOutcome(approvalId: string): Promise<void> {
    try {
      const r = await fetch(
        `/api/approvals/${encodeURIComponent(approvalId)}/outcome`,
        { cache: "no-store" },
      );
      if (!r.ok) return;
      const body = (await r.json()) as {
        approval: { decision: string };
        outcome: ChatApprovalState["outcome"];
      };
      const decision: ChatApprovalState["decision"] =
        body.approval.decision === "auto_approved"
          ? "approved"
          : (body.approval.decision as ChatApprovalState["decision"]);
      setState((s) => ({
        ...s,
        [approvalId]: {
          ...(s[approvalId] ?? {
            decision: "pending",
            outcome: null,
            inFlight: false,
            error: null,
          }),
          decision,
          outcome: body.outcome ?? null,
        },
      }));
      const stillWatching =
        decision === "approved" &&
        (!body.outcome ||
          body.outcome.status === "queued" ||
          body.outcome.status === "applied");
      if (stillWatching) void pollOutcome(approvalId);
    } catch {
      /* fail-soft */
    }
  }

  // Group same-actionType drafts as a carousel so the operator can
  // swipe through "send to alice in EN, bob in ES, chen in ZH" before
  // approving each. The trigger is "2+ chips with the same actionType
  // back-to-back" — covers the multi-recipient / multi-language draft
  // case without forcing a carousel for unrelated actions like
  // crm.note + email.send (those stay stacked).
  const groups = groupConsecutive(approvals, (a) => a.actionType);

  return (
    <div className="mt-2 flex flex-col gap-2">
      {groups.map((group, gi) => {
        if (group.length === 1) {
          const a = group[0];
          if (!a) return null;
          const s = state[a.approvalId];
          if (!s) return null;
          return (
            <InlineApprovalChip
              key={a.approvalId}
              approval={a}
              state={s}
              onDecide={(action) => void decide(a.approvalId, action)}
              onRefresh={() => refreshOutcome(a.approvalId)}
            />
          );
        }
        return (
          <ApprovalCarousel
            key={`group-${gi}`}
            approvals={group}
            state={state}
            onDecide={(approvalId, action) =>
              void decide(approvalId, action)
            }
            onRefresh={(approvalId) => refreshOutcome(approvalId)}
          />
        );
      })}
    </div>
  );
}

function groupConsecutive<T, K>(
  items: T[],
  keyOf: (item: T) => K,
): T[][] {
  const out: T[][] = [];
  for (const item of items) {
    const last = out[out.length - 1];
    if (last && keyOf(last[0] as T) === keyOf(item)) {
      last.push(item);
    } else {
      out.push([item]);
    }
  }
  return out;
}

/**
 * Carousel of N drafts of the same actionType (e.g., five email.send
 * drafts, one per recipient and language). Operator pages through
 * with arrows or 1/2/3 dots; each draft shows the inline preview
 * + its own Approve/Reject. Approving / rejecting one auto-advances
 * to the next pending draft so the operator can power through a
 * batch without clicking the dot.
 */
function ApprovalCarousel({
  approvals,
  state,
  onDecide,
  onRefresh,
}: {
  approvals: CreatedApprovalMeta[];
  state: Record<string, ChatApprovalState>;
  onDecide: (approvalId: string, action: "approve" | "reject") => void;
  onRefresh: (approvalId: string) => Promise<void> | void;
}) {
  const [index, setIndex] = useState(0);
  const safeIndex = Math.max(0, Math.min(index, approvals.length - 1));
  const current = approvals[safeIndex];

  const carouselRef = useRef<HTMLDivElement | null>(null);
  // Arrow-key nav: only when the carousel (or anything inside it) has
  // focus, so we don't intercept arrow keys while the operator is
  // typing in the chat composer. Tab into the carousel container to
  // activate. Wrapping arithmetic clamps inside the bounds.
  useEffect(() => {
    const node = carouselRef.current;
    if (!node) return;
    const onKey = (e: globalThis.KeyboardEvent): void => {
      if (e.key === "ArrowLeft") {
        e.preventDefault();
        setIndex((i) => Math.max(0, i - 1));
      } else if (e.key === "ArrowRight") {
        e.preventDefault();
        setIndex((i) => Math.min(approvals.length - 1, i + 1));
      }
    };
    node.addEventListener("keydown", onKey);
    return () => {
      node.removeEventListener("keydown", onKey);
    };
  }, [approvals.length]);

  if (!current) return null;
  const s = state[current.approvalId];
  if (!s) return null;
  const pendingCount = approvals.filter(
    (a) => state[a.approvalId]?.decision === "pending",
  ).length;

  const advanceToNextPending = (): void => {
    for (let i = safeIndex + 1; i < approvals.length; i++) {
      const a = approvals[i];
      if (a && state[a.approvalId]?.decision === "pending") {
        setIndex(i);
        return;
      }
    }
    // No further pending → just step forward by one (or stay).
    setIndex(Math.min(safeIndex + 1, approvals.length - 1));
  };

  const handleDecide = (action: "approve" | "reject"): void => {
    onDecide(current.approvalId, action);
    // Auto-advance after a beat so the operator sees the state
    // transition before the next draft slides in.
    setTimeout(advanceToNextPending, 250);
  };

  return (
    <div
      ref={carouselRef}
      tabIndex={0}
      data-testid="inline-approval-carousel"
      className="rounded-lg border border-warn/30 bg-warn/5 p-3 focus-visible:outline focus-visible:outline-1 focus-visible:outline-warn/40"
      aria-label={`Approval carousel, draft ${safeIndex + 1} of ${approvals.length}. Use arrow keys to navigate.`}
    >
      <div className="mb-2 flex items-center justify-between text-xs text-white/60">
        <span className="font-mono">
          {current.actionType}{" "}
          <span className="text-white/40">·</span>{" "}
          draft {safeIndex + 1} of {approvals.length}
        </span>
        <div className="flex items-center gap-2">
          <button
            type="button"
            aria-label="Previous draft"
            onClick={() => setIndex(Math.max(0, safeIndex - 1))}
            disabled={safeIndex === 0}
            className="rounded p-1 text-white/60 transition hover:bg-white/10 hover:text-white disabled:opacity-30"
          >
            ←
          </button>
          <div className="flex gap-1">
            {approvals.map((a, i) => {
              const decided = state[a.approvalId]?.decision !== "pending";
              return (
                <button
                  key={a.approvalId}
                  type="button"
                  aria-label={`Go to draft ${i + 1}`}
                  onClick={() => setIndex(i)}
                  className={`h-1.5 w-1.5 rounded-full transition ${
                    i === safeIndex
                      ? "bg-warn"
                      : decided
                        ? "bg-good/60"
                        : "bg-white/30 hover:bg-white/50"
                  }`}
                />
              );
            })}
          </div>
          <button
            type="button"
            aria-label="Next draft"
            onClick={() =>
              setIndex(Math.min(approvals.length - 1, safeIndex + 1))
            }
            disabled={safeIndex === approvals.length - 1}
            className="rounded p-1 text-white/60 transition hover:bg-white/10 hover:text-white disabled:opacity-30"
          >
            →
          </button>
        </div>
      </div>
      <InlineApprovalChip
        approval={current}
        state={s}
        onDecide={handleDecide}
        onRefresh={() => onRefresh(current.approvalId)}
        embedded
      />
      {pendingCount > 1 ? (
        <div className="mt-2 flex items-center justify-end gap-2 border-t border-warn/20 pt-2">
          <button
            type="button"
            data-testid="carousel-approve-all"
            onClick={() => {
              for (const a of approvals) {
                if (state[a.approvalId]?.decision === "pending") {
                  onDecide(a.approvalId, "approve");
                }
              }
              setIndex(approvals.length - 1);
            }}
            className="rounded-md bg-good/80 px-2.5 py-1 text-[11px] font-medium text-canvas transition hover:bg-good"
          >
            Approve all {pendingCount} pending
          </button>
        </div>
      ) : null}
    </div>
  );
}

function InlineApprovalChip({
  approval,
  state,
  onDecide,
  onRefresh,
  embedded,
}: {
  approval: CreatedApprovalMeta;
  state: ChatApprovalState;
  onDecide: (action: "approve" | "reject") => void;
  /** Manually re-fetch the outcome when the polling window has expired. */
  onRefresh: () => Promise<void> | void;
  /** When the chip is rendered inside the carousel, drop the outer
   *  border + status-tinted background so the carousel's frame doesn't
   *  double up. */
  embedded?: boolean;
}) {
  const draft = extractDraftPreview(approval);
  const isMessageAction =
    approval.actionType === "email.send" ||
    approval.actionType === "sms.send" ||
    approval.actionType === "whatsapp.send";
  const statusPill = (() => {
    if (state.outcome?.status === "delivered") {
      return {
        tone: "bg-good/30 text-good",
        label: "delivered",
        title: isMessageAction
          ? "Recipient's mailbox accepted the message (Resend email.delivered webhook)."
          : "Action completed successfully.",
      };
    }
    if (state.outcome?.status === "applied") {
      // For email/sms/whatsapp the apply step just hands the message
      // to Resend / Twilio — call it "sent" so the operator reads
      // the chip the same way they'd read their inbox. Other action
      // types (crm.note, deal.status_change, …) keep "applied".
      return {
        tone: "bg-good/20 text-good",
        label: isMessageAction ? "sent" : "applied",
        title: isMessageAction
          ? "Handed off to Resend. Waiting on the delivered webhook to confirm inbox arrival."
          : "Action applied to the workspace.",
      };
    }
    if (state.outcome?.status === "failed") {
      return {
        tone: "bg-bad/20 text-bad",
        label: "executor failed",
        title: "The worker tried to apply this action and hit an error. See message below.",
      };
    }
    if (state.outcome?.status === "skipped") {
      return {
        tone: "bg-white/10 text-white/70",
        label: "already applied",
        title: "The executor saw the action had already run and skipped it (idempotency).",
      };
    }
    if (state.decision === "approved") {
      return {
        tone: "bg-good/20 text-good",
        label: "queued",
        title: "Approved — waiting on the worker to pick the action up.",
      };
    }
    if (state.decision === "rejected") {
      return {
        tone: "bg-bad/20 text-bad",
        label: "rejected",
        title: "You rejected this action. Nothing was applied.",
      };
    }
    return null;
  })();

  // Detect a chip that's been approved but the executor hasn't moved
  // it to a terminal state. We surface a "Refresh" affordance so the
  // operator can manually re-check without reloading the page when
  // the polling schedule has expired.
  const isPendingTerminal = (() => {
    if (state.decision !== "approved") return false;
    const status = state.outcome?.status ?? "queued";
    return (
      status !== "delivered" && status !== "failed" && status !== "skipped"
    );
  })();

  const disabled = state.inFlight || state.decision !== "pending";

  const containerClass = embedded
    ? "flex flex-col gap-1.5 text-xs"
    : `flex flex-col gap-1.5 rounded-lg border px-3 py-2 text-xs transition ${
        state.decision === "pending"
          ? "border-warn/40 bg-warn/5"
          : state.outcome?.status === "failed"
            ? "border-bad/40 bg-bad/5"
            : "border-good/30 bg-good/5"
      }`;

  return (
    <div data-testid="inline-approval-chip" className={containerClass}>
      <div className="flex flex-wrap items-center gap-2">
        <span
          aria-hidden="true"
          className={`h-1.5 w-1.5 rounded-full ${
            state.decision === "pending"
              ? "bg-warn"
              : state.outcome?.status === "failed"
                ? "bg-bad"
                : "bg-good"
          }`}
        />
        <span className="font-mono text-white/90">{approval.actionType}</span>
        <span className="rounded bg-white/10 px-1.5 py-0.5 text-[10px] font-mono text-white/60">
          {approval.tier}
        </span>
        {statusPill ? (
          <span
            className={`rounded px-1.5 py-0.5 ${statusPill.tone}`}
            title={statusPill.title}
          >
            {statusPill.label}
          </span>
        ) : null}
        <span className="ml-auto flex items-center gap-1.5">
          {state.decision === "pending" ? (
            <>
              <button
                type="button"
                data-testid="inline-approve"
                onClick={() => onDecide("approve")}
                disabled={disabled}
                className="rounded-md bg-good px-2.5 py-1 text-xs font-medium text-canvas transition hover:bg-good/80 disabled:opacity-40"
              >
                Approve
              </button>
              <button
                type="button"
                data-testid="inline-reject"
                onClick={() => onDecide("reject")}
                disabled={disabled}
                className="rounded-md border border-line px-2.5 py-1 text-xs text-white/70 transition hover:bg-white/5 disabled:opacity-40"
              >
                Reject
              </button>
            </>
          ) : (
            <>
              {isPendingTerminal ? (
                <button
                  type="button"
                  onClick={() => void onRefresh()}
                  title="Re-check the executor outcome — useful when polling has timed out and the chip is still 'queued' or 'sent'."
                  className="text-[11px] text-white/50 underline-offset-2 hover:text-white/80 hover:underline"
                >
                  Refresh
                </button>
              ) : null}
              <Link
                href="/app/approvals"
                className="text-[11px] text-white/50 underline-offset-2 hover:text-white/80 hover:underline"
              >
                Open inbox →
              </Link>
            </>
          )}
        </span>
      </div>
      {draft ? <DraftPreview draft={draft} /> : null}
      {state.outcome?.status === "failed" && state.outcome.reason ? (
        <p className="text-[11px] leading-relaxed text-bad">
          ⚠ {state.outcome.reason}
        </p>
      ) : null}
      {state.error ? (
        <p className="text-[11px] text-bad">⚠ {state.error}</p>
      ) : null}
    </div>
  );
}

interface DraftPreview {
  /** "to: alice@x.com" / "to: +1 832 …" — the row's recipient line. */
  recipient?: string;
  /** Optional subject (email.send). */
  subject?: string;
  /** Body text — newlines preserved when rendered. */
  body: string;
  /** ISO 639-1 code if the draft is tagged with a language. */
  lang?: string;
}

/**
 * Pulls a renderable draft preview off an approval payload. Recognises
 * email.send / sms.send / whatsapp.send today; returns null for other
 * action types so the chip falls back to the bare actionType label.
 */
function extractDraftPreview(
  approval: CreatedApprovalMeta,
): DraftPreview | null {
  const p = (approval.payload ?? {}) as Record<string, unknown>;
  const body =
    typeof p["body"] === "string" && (p["body"] as string).trim().length > 0
      ? (p["body"] as string)
      : null;
  if (!body) return null;
  const recipient = ((): string | undefined => {
    const to = p["to"];
    if (typeof to === "string") return `to: ${to}`;
    if (Array.isArray(to) && to.length > 0 && typeof to[0] === "string") {
      return to.length === 1
        ? `to: ${to[0]}`
        : `to: ${to[0]} +${to.length - 1}`;
    }
    return undefined;
  })();
  const subject =
    typeof p["subject"] === "string" && (p["subject"] as string).trim()
      ? (p["subject"] as string)
      : undefined;
  const lang =
    typeof p["lang"] === "string" && (p["lang"] as string).length === 2
      ? (p["lang"] as string)
      : undefined;
  return {
    body,
    ...(recipient ? { recipient } : {}),
    ...(subject ? { subject } : {}),
    ...(lang ? { lang } : {}),
  };
}

function DraftPreview({ draft }: { draft: DraftPreview }) {
  return (
    <div className="mt-1 rounded-md border border-line/60 bg-canvas/40 p-2.5">
      {draft.recipient ? (
        <div className="text-[11px] text-white/60">
          {draft.recipient}
          {draft.lang ? (
            <span className="ml-2 rounded border border-line px-1.5 py-0.5 text-[10px] uppercase tracking-wider text-white/50">
              {draft.lang}
            </span>
          ) : null}
        </div>
      ) : null}
      {draft.subject ? (
        <div className="mt-1 text-xs font-semibold text-white/85">
          {draft.subject}
        </div>
      ) : null}
      <pre className="mt-1 whitespace-pre-wrap font-sans text-[12px] leading-relaxed text-white/80">
        {draft.body}
      </pre>
    </div>
  );
}

/**
 * Muted chips for T2+ proposals Claude emitted that failed server-
 * side ActionDescriptor validation. Without this, a Claude prose
 * "I'll set up the call" paired with a malformed payload produced
 * silent nothing — the user sees Claude's intent but no chip and
 * no explanation. Rendering the reason gives them a path forward
 * ("ask again with a real contact id", "provide the phone number",
 * etc).
 */
function RejectedProposalChips({
  rejected,
}: {
  rejected: Array<{ actionType: string; tier: string; reason: string }>;
}) {
  return (
    <div className="mt-2 flex flex-col gap-1.5">
      {rejected.map((r, i) => (
        <div
          key={`${r.actionType}-${i}`}
          data-testid="rejected-proposal-chip"
          className="flex flex-col gap-1 rounded-lg border border-line bg-muted/40 px-3 py-2 text-xs"
        >
          <div className="flex flex-wrap items-center gap-2">
            <span
              aria-hidden="true"
              className="h-1.5 w-1.5 rounded-full bg-white/30"
            />
            <span className="font-mono text-white/60">{r.actionType}</span>
            <span className="rounded bg-white/10 px-1.5 py-0.5 text-[10px] font-mono text-white/50">
              {r.tier}
            </span>
            <span className="rounded bg-white/10 px-1.5 py-0.5 text-white/60">
              rejected — shape invalid
            </span>
          </div>
          <p className="text-[11px] leading-relaxed text-white/60">
            Claude proposed this action but the payload didn&rsquo;t match the
            schema:{" "}
            <span className="font-mono text-white/70">{r.reason}</span>
          </p>
          <p className="text-[11px] italic text-white/40">
            Ask again with the missing detail (real contact/org, E.164
            phone, etc.) or disambiguate the subject.
          </p>
        </div>
      ))}
    </div>
  );
}

/**
 * Working-state indicator that escalates its message as time passes,
 * so a long-running tool call (web search, retrieval) doesn't look
 * hung. Server-side `/query/stream` is buffered today — the model
 * may be running tool calls for several seconds before any token
 * lands — so the perceived-responsiveness story has to live on the
 * client until we wire SSE progress events.
 *
 *   t < 2s : just dots
 *   t 2–6s : dots + "thinking…"
 *   t 6–15s: dots + "looking up your data…"
 *   t > 15s: dots + "searching the web — this can take a moment"
 *
 * The phrasing leans towards likely activities (Anthropic + Tavily +
 * retrieval) without claiming to know what's actually happening
 * server-side. Once the API streams real tool-use events we can swap
 * this for the actual phase.
 */
function TypingIndicator() {
  const [elapsedSec, setElapsedSec] = useState(0);
  useEffect(() => {
    const start = Date.now();
    const id = setInterval(() => {
      setElapsedSec(Math.floor((Date.now() - start) / 1000));
    }, 500);
    return () => clearInterval(id);
  }, []);

  let label: string | null = null;
  if (elapsedSec >= 15) {
    label = "searching the web — this can take a moment";
  } else if (elapsedSec >= 6) {
    label = "looking up your data…";
  } else if (elapsedSec >= 2) {
    label = "thinking…";
  }

  return (
    <span className="inline-flex items-center gap-2" aria-label="Vex is working">
      <span className="inline-flex items-center gap-1">
        <Dot delay={0} />
        <Dot delay={0.18} />
        <Dot delay={0.36} />
      </span>
      {label && (
        <motion.span
          key={label}
          initial={{ opacity: 0, x: -4 }}
          animate={{ opacity: 1, x: 0 }}
          transition={{ duration: 0.25, ease: "easeOut" }}
          className="text-xs text-white/50"
        >
          {label}
        </motion.span>
      )}
    </span>
  );
}

/**
 * Terminal-style blinking caret at the tail of a streaming answer.
 * Framer-motion opacity loop gives a softer blink than `animate-pulse`'s
 * step-timed cycle — the model is alive, not a dead CRT.
 */
function StreamingCaret() {
  return (
    <motion.span
      aria-hidden
      className="ml-0.5 inline-block h-[1em] w-[0.5ch] translate-y-[0.15em] bg-accent"
      animate={{ opacity: [1, 0.35, 1] }}
      transition={{ duration: 1, repeat: Infinity, ease: "easeInOut" }}
    />
  );
}

function Dot({ delay }: { delay: number }) {
  return (
    <motion.span
      className="inline-block h-1.5 w-1.5 rounded-full bg-white/70"
      animate={{ opacity: [0.35, 1, 0.35], y: [0, -2, 0] }}
      transition={{ duration: 1.1, repeat: Infinity, ease: "easeInOut", delay }}
    />
  );
}

function MicIcon() {
  return (
    <svg
      viewBox="0 0 20 20"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="h-5 w-5"
      aria-hidden
    >
      <rect x="7.5" y="2.5" width="5" height="9" rx="2.5" />
      <path d="M4.5 9.5a5.5 5.5 0 0 0 11 0" />
      <path d="M10 15v2.5" />
    </svg>
  );
}

function MicStopIcon() {
  return (
    <svg viewBox="0 0 20 20" fill="currentColor" className="h-3 w-3" aria-hidden>
      <rect x="4" y="4" width="12" height="12" rx="1.5" />
    </svg>
  );
}

/**
 * "Copy as Markdown" affordance — turns the visible conversation into
 * a markdown blob suitable for pasting into a bug report, into procur's
 * chat for cross-platform diagnosis, etc. Faster than screenshots and
 * preserves the action / approval state alongside prose.
 */
function CopyAsMarkdownButton({ turns }: { turns: ChatTurn[] }) {
  const [copied, setCopied] = useState(false);
  async function onClick() {
    try {
      const md = formatConversationAsMarkdown(turns);
      await navigator.clipboard.writeText(md);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1800);
    } catch {
      /* clipboard write blocked; do nothing — operator will see no
         "Copied" feedback and can fall back to manual select */
    }
  }
  return (
    <button
      type="button"
      onClick={onClick}
      data-testid="chat-copy-md"
      className="rounded-md border border-line-soft bg-surface-2/40 px-2.5 py-1 text-[11px] text-text-secondary transition-colors hover:border-line-strong hover:text-text-primary"
      title="Copy the whole conversation as Markdown — including action chips and decision state."
    >
      {copied ? "Copied" : "Copy as Markdown"}
    </button>
  );
}

function formatConversationAsMarkdown(turns: ChatTurn[]): string {
  const blocks: string[] = [];
  for (const turn of turns) {
    if (turn.role === "user") {
      blocks.push(`**You:**\n\n${turn.text.trim()}`);
      continue;
    }
    const parts: string[] = [`**Vex:**\n\n${turn.text.trim()}`];
    const created = turn.manifest?.created_approvals ?? [];
    const rejected = turn.manifest?.rejected_proposals ?? [];
    if (created.length > 0) {
      parts.push(
        `\n*Proposed actions:*\n` +
          created
            .map((a) => {
              const payloadLines = a.payload
                ? Object.entries(a.payload)
                    .filter(([, v]) => v !== undefined && v !== null)
                    .slice(0, 6)
                    .map(([k, v]) => `    - ${k}: ${formatPayloadValue(v)}`)
                    .join("\n")
                : "";
              return [
                `- \`${a.actionType}\` (${a.tier}) — id \`${a.approvalId.slice(-8)}\``,
                payloadLines,
              ]
                .filter(Boolean)
                .join("\n");
            })
            .join("\n"),
      );
    }
    if (rejected.length > 0) {
      parts.push(
        `\n*Rejected by validator:*\n` +
          rejected
            .map((r) => `- \`${r.actionType}\` (${r.tier}) — ${r.reason}`)
            .join("\n"),
      );
    }
    blocks.push(parts.join("\n"));
  }
  return blocks.join("\n\n---\n\n");
}

function formatPayloadValue(v: unknown): string {
  if (typeof v === "string") {
    // Trim long fields (body, html signature, etc.) so the markdown
    // stays readable when pasted.
    if (v.length > 240) return JSON.stringify(`${v.slice(0, 240)}…`);
    return JSON.stringify(v);
  }
  if (Array.isArray(v)) return JSON.stringify(v);
  if (typeof v === "object" && v !== null) return JSON.stringify(v);
  return String(v);
}
