"use client";

import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
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
        <div className="mx-auto flex max-w-3xl items-end gap-2">
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKey}
            placeholder="Ask Vex…"
            rows={1}
            data-testid="chat-input"
            className="min-h-[44px] flex-1 resize-none rounded-md border border-line bg-muted/60 px-3 py-2 text-base text-white outline-none focus:border-accent md:text-sm"
          />
          <button
            type="submit"
            disabled={isStreaming || !input.trim()}
            className="rounded-md bg-accent px-4 py-2 text-sm font-medium text-white disabled:opacity-30"
          >
            Send
          </button>
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
    status: "queued" | "applied" | "failed" | "skipped";
    reason: string | null;
  };
  inFlight: boolean;
  error: string | null;
}

interface CreatedApprovalMeta {
  approvalId: string;
  actionType: string;
  tier: string;
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
    for (let attempt = 0; attempt < 7; attempt++) {
      await new Promise((r) => setTimeout(r, attempt === 0 ? 2_000 : 10_000));
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
        if (body.outcome.status !== "queued") return;
      } catch {
        /* keep trying until attempts run out */
      }
    }
  }

  return (
    <div className="mt-2 flex flex-col gap-2">
      {approvals.map((a) => {
        const s = state[a.approvalId];
        if (!s) return null;
        return (
          <InlineApprovalChip
            key={a.approvalId}
            approval={a}
            state={s}
            onDecide={(action) => void decide(a.approvalId, action)}
          />
        );
      })}
    </div>
  );
}

function InlineApprovalChip({
  approval,
  state,
  onDecide,
}: {
  approval: CreatedApprovalMeta;
  state: ChatApprovalState;
  onDecide: (action: "approve" | "reject") => void;
}) {
  const statusPill = (() => {
    if (state.outcome?.status === "applied") {
      return { tone: "bg-good/20 text-good", label: "applied" };
    }
    if (state.outcome?.status === "failed") {
      return { tone: "bg-bad/20 text-bad", label: "executor failed" };
    }
    if (state.outcome?.status === "skipped") {
      return { tone: "bg-white/10 text-white/70", label: "already applied" };
    }
    if (state.decision === "approved") {
      return { tone: "bg-good/20 text-good", label: "queued" };
    }
    if (state.decision === "rejected") {
      return { tone: "bg-bad/20 text-bad", label: "rejected" };
    }
    return null;
  })();

  const disabled = state.inFlight || state.decision !== "pending";

  return (
    <div
      data-testid="inline-approval-chip"
      className={`flex flex-col gap-1.5 rounded-lg border px-3 py-2 text-xs transition ${
        state.decision === "pending"
          ? "border-warn/40 bg-warn/5"
          : state.outcome?.status === "failed"
            ? "border-bad/40 bg-bad/5"
            : "border-good/30 bg-good/5"
      }`}
    >
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
          <span className={`rounded px-1.5 py-0.5 ${statusPill.tone}`}>
            {statusPill.label}
          </span>
        ) : null}
        <span className="ml-auto flex gap-1.5">
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
            <Link
              href="/app/approvals"
              className="text-[11px] text-white/50 underline-offset-2 hover:text-white/80 hover:underline"
            >
              Open inbox →
            </Link>
          )}
        </span>
      </div>
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

function TypingIndicator() {
  return (
    <span className="inline-flex items-center gap-1" aria-label="Vex is typing">
      <Dot delay={0} />
      <Dot delay={0.18} />
      <Dot delay={0.36} />
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
