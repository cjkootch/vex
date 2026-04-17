"use client";

import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import {
  useVexQuery,
  type HistoryTurn,
  type ManifestEvent,
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
}

export function ConversationThread({ turns, onTurns }: Props) {
  const [input, setInput] = useState("");
  const { text, manifest, isStreaming, wakingUp, error, send } = useVexQuery();
  const bottomRef = useRef<HTMLDivElement | null>(null);

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
    void send(message, history);
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex-1 overflow-y-auto px-6 py-4">
        <div className="mx-auto flex max-w-3xl flex-col gap-6">
          {turns.length === 0 && (
            <p className="text-center text-sm text-white/40">
              Ask a question about your accounts, contacts, or campaigns.
            </p>
          )}
          {turns.map((turn) => (
            <Turn key={turn.id} turn={turn} />
          ))}
          {isStreaming && (
            <div className="self-start" data-testid="assistant-streaming">
              <div className="rounded-2xl bg-muted/60 px-4 py-3 text-sm text-white/90">
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
                <div className="mt-3 inline-flex items-center gap-2 rounded-md border border-line bg-canvas/60 px-2.5 py-1 text-[10px] uppercase tracking-wider text-white/50">
                  <span className="inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-accent" />
                  preparing canvas…
                </div>
              )}
            </div>
          )}
          {error && (
            <p className="self-start rounded-md bg-bad/10 px-3 py-2 text-sm text-bad">
              {error}
            </p>
          )}
          <div ref={bottomRef} />
        </div>
      </div>

      <form
        onSubmit={handleSubmit}
        className="border-t border-line bg-canvas/80 px-6 py-4"
      >
        <div className="mx-auto flex max-w-3xl items-end gap-2">
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKey}
            placeholder="Ask Vex…"
            rows={1}
            data-testid="chat-input"
            className="min-h-[44px] flex-1 resize-none rounded-md border border-line bg-muted/60 px-3 py-2 text-sm text-white outline-none focus:border-accent"
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
  if (turn.role === "user") {
    return (
      <div className="self-end max-w-[85%] rounded-2xl bg-accent/20 px-4 py-3 text-sm text-white">
        {turn.text}
      </div>
    );
  }
  return (
    <div className="self-start w-full max-w-[85%]" data-testid="assistant-turn">
      <div className="rounded-2xl bg-muted/60 px-4 py-3 text-sm text-white/90">
        {turn.text ? renderProse(turn.text) : <span className="text-white/40">No response.</span>}
      </div>
      {turn.createdAt && <AgentTrace since={turn.createdAt} />}
      {turn.manifest && (
        <div className="mt-3" data-testid="manifest-canvas">
          <ManifestCanvas manifest={turn.manifest.manifest} rawAnswer={turn.text} />
        </div>
      )}
    </div>
  );
}

function TypingIndicator() {
  return (
    <span className="inline-flex items-center gap-1" aria-label="Vex is typing">
      <Dot delay={0} />
      <Dot delay={0.15} />
      <Dot delay={0.3} />
    </span>
  );
}

/**
 * Terminal-style blinking caret rendered at the tail of an
 * in-flight streaming answer — Meridian's \"phosphor\" signal that
 * the model is still writing. Hidden once isStreaming flips off.
 */
function StreamingCaret() {
  return (
    <span
      aria-hidden
      className="ml-0.5 inline-block h-[1em] w-[0.5ch] translate-y-[0.15em] animate-pulse bg-accent"
    />
  );
}

function Dot({ delay }: { delay: number }) {
  return (
    <span
      className="inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-white/60"
      style={{ animationDelay: `${delay}s` }}
    />
  );
}
