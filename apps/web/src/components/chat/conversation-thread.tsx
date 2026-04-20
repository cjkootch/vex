"use client";

import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
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
  return (
    <motion.div
      {...common}
      className="self-start w-full max-w-[85%]"
      data-testid="assistant-turn"
    >
      <div className="rounded-2xl bg-muted/60 px-4 py-3 text-sm text-white/90 shadow-sm shadow-black/10">
        {turn.text ? renderProse(turn.text) : <span className="text-white/40">No response.</span>}
      </div>
      {turn.createdAt && <AgentTrace since={turn.createdAt} />}
      {turn.manifest && (
        <div className="mt-3" data-testid="manifest-canvas">
          <ManifestCanvas manifest={turn.manifest.manifest} rawAnswer={turn.text} />
        </div>
      )}
    </motion.div>
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
