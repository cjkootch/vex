"use client";

import { useCallback, useRef, useState } from "react";

export interface CreatedApproval {
  approvalId: string;
  actionType: string;
  tier: string;
  /**
   * Proposed action payload — used by the chat UI to render inline
   * draft previews (subject + body for email.send, etc.) without an
   * extra fetch per chip. Optional because the api shape evolved;
   * older responses omit it.
   */
  payload?: Record<string, unknown>;
}

export interface RejectedProposal {
  actionType: string;
  tier: string;
  reason: string;
}

export interface ManifestEvent {
  manifest: unknown;
  proposed_actions?: unknown[];
  /**
   * T2+ approvals the server persisted for this turn. The chat UI
   * renders approve/reject chips inline so the operator can fire
   * them without leaving the conversation.
   */
  created_approvals?: CreatedApproval[];
  /**
   * T2+ proposals Claude emitted that failed ActionDescriptor
   * validation (e.g. contactId wasn't a ULID, toNumber wasn't E.164).
   * Rendered as muted chips so the operator sees the real reason
   * their request "silently" didn't land.
   */
  rejected_proposals?: RejectedProposal[];
  evidence_refs?: string[];
  cost_usd?: number;
  cache_hit?: boolean;
  manifest_valid?: boolean;
}

export interface HistoryTurn {
  role: "user" | "assistant";
  text: string;
}

export interface QueryScope {
  type: "contact" | "deal" | "organization" | "campaign";
  id: string;
}

export interface VexQueryState {
  text: string;
  manifest: ManifestEvent | null;
  isStreaming: boolean;
  /**
   * True while we're retrying after an upstream 502/503 — the API
   * machine is probably cold-starting. The ConversationThread can
   * use this to surface a friendlier message than "HTTP 503".
   */
  wakingUp: boolean;
  /**
   * Name of the tool currently running on the server (e.g.
   * `apollo_people_search`, `research_contact`). Set on `tool_start`,
   * cleared on `tool_end`. The TypingIndicator renders this as
   * "Searching Apollo…" with a per-tool icon.
   */
  currentTool: string | null;
  error: string | null;
}

const INITIAL: VexQueryState = {
  text: "",
  manifest: null,
  isStreaming: false,
  wakingUp: false,
  currentTool: null,
  error: null,
};

/** Fly cold starts can take up to ~20s. One 4s retry covers most cases. */
const COLD_START_RETRY_DELAY_MS = 4000;

/**
 * Custom SSE consumer for `POST /api/query/stream`.
 *
 * Why not Vercel AI SDK's `useChat`? Vex's stream uses the `event:` SSE
 * convention with named events (`token`, `manifest`, `done`, `error`).
 * `useChat` expects the AI SDK's stream-data protocol — incompatible.
 * A small handwritten parser keeps the wire format simple and explicit.
 *
 * Cold-start handling: if the first fetch returns 502 (bad gateway)
 * or 503 (service unavailable), we wait COLD_START_RETRY_DELAY_MS
 * and try once more. Fly's `auto_start_machines` wakes the API on
 * demand but the initial request often lands before boot completes.
 */
export function useVexQuery() {
  const [state, setState] = useState<VexQueryState>(INITIAL);
  const abortRef = useRef<AbortController | null>(null);

  const reset = useCallback(() => {
    abortRef.current?.abort();
    setState(INITIAL);
  }, []);

  const send = useCallback(
    async (
      message: string,
      history?: HistoryTurn[],
      scope?: QueryScope,
    ) => {
      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;

      setState({
        text: "",
        manifest: null,
        isStreaming: true,
        wakingUp: false,
        currentTool: null,
        error: null,
      });

      const doFetch = (): Promise<Response> =>
        fetch("/api/query/stream", {
          method: "POST",
          headers: { "content-type": "application/json", accept: "text/event-stream" },
          body: JSON.stringify({
            message,
            history: history ?? [],
            ...(scope ? { scope } : {}),
          }),
          signal: controller.signal,
        });

    try {
      let response = await doFetch();
      if (response.status === 502 || response.status === 503) {
        // Cold start — the Fly machine is waking up. Surface a
        // message to the UI and retry once.
        setState((s) => ({ ...s, wakingUp: true }));
        await sleep(COLD_START_RETRY_DELAY_MS, controller.signal);
        response = await doFetch();
      }

      if (!response.ok || !response.body) {
        throw new Error(
          response.status === 502 || response.status === 503
            ? "API is waking up — please try again in a moment."
            : `HTTP ${response.status}`,
        );
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const events = drainEvents(buffer);
        buffer = events.remainder;

        for (const event of events.parsed) {
          handleEvent(event, setState);
        }
      }
      setState((s) => ({
        ...s,
        isStreaming: false,
        wakingUp: false,
        currentTool: null,
      }));
    } catch (err) {
      if (controller.signal.aborted) return;
      setState((s) => ({
        ...s,
        isStreaming: false,
        wakingUp: false,
        error: (err as Error).message,
      }));
    }
  }, []);

  return { ...state, send, reset };
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new DOMException("aborted", "AbortError"));
      return;
    }
    const timer = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => {
      clearTimeout(timer);
      reject(new DOMException("aborted", "AbortError"));
    });
  });
}

interface ParsedEvent {
  event: string;
  data: string;
}

/**
 * Pull complete `event: ...\ndata: ...\n\n` blocks out of the buffered
 * stream. Returns the parsed events and whatever partial event is left
 * in the trailing remainder.
 */
function drainEvents(buffer: string): { parsed: ParsedEvent[]; remainder: string } {
  const parsed: ParsedEvent[] = [];
  let cursor = 0;
  for (;;) {
    const boundary = buffer.indexOf("\n\n", cursor);
    if (boundary === -1) break;
    const block = buffer.slice(cursor, boundary);
    cursor = boundary + 2;
    let event = "message";
    const dataLines: string[] = [];
    for (const line of block.split("\n")) {
      if (line.startsWith("event:")) event = line.slice(6).trim();
      else if (line.startsWith("data:")) dataLines.push(line.slice(5).trimStart());
    }
    parsed.push({ event, data: dataLines.join("\n") });
  }
  return { parsed, remainder: buffer.slice(cursor) };
}

function handleEvent(
  event: ParsedEvent,
  setState: (updater: (prev: VexQueryState) => VexQueryState) => void,
): void {
  switch (event.event) {
    case "token": {
      const data = safeJson<{ text?: string }>(event.data);
      if (data?.text) setState((s) => ({ ...s, text: s.text + data.text }));
      return;
    }
    case "manifest": {
      const data = safeJson<ManifestEvent>(event.data);
      if (data) setState((s) => ({ ...s, manifest: data }));
      return;
    }
    case "tool_start": {
      const data = safeJson<{ tool?: string }>(event.data);
      if (data?.tool) setState((s) => ({ ...s, currentTool: data.tool ?? null }));
      return;
    }
    case "tool_end": {
      // Clear once the tool finishes; the next tool_start (if any)
      // will repopulate it. Keeps the indicator honest when the
      // model chains tools.
      setState((s) => ({ ...s, currentTool: null }));
      return;
    }
    case "error": {
      const data = safeJson<{ message?: string }>(event.data);
      setState((s) => ({ ...s, error: data?.message ?? "stream error" }));
      return;
    }
    case "done":
    default:
      return;
  }
}

function safeJson<T>(raw: string): T | null {
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}
