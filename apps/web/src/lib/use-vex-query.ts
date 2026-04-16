"use client";

import { useCallback, useRef, useState } from "react";

export interface ManifestEvent {
  manifest: unknown;
  proposed_actions?: unknown[];
  evidence_refs?: string[];
  cost_usd?: number;
  cache_hit?: boolean;
  manifest_valid?: boolean;
}

export interface VexQueryState {
  text: string;
  manifest: ManifestEvent | null;
  isStreaming: boolean;
  error: string | null;
}

const INITIAL: VexQueryState = {
  text: "",
  manifest: null,
  isStreaming: false,
  error: null,
};

/**
 * Custom SSE consumer for `POST /api/query/stream`.
 *
 * Why not Vercel AI SDK's `useChat`? Vex's stream uses the `event:` SSE
 * convention with named events (`token`, `manifest`, `done`, `error`).
 * `useChat` expects the AI SDK's stream-data protocol — incompatible.
 * A small handwritten parser keeps the wire format simple and explicit.
 */
export function useVexQuery() {
  const [state, setState] = useState<VexQueryState>(INITIAL);
  const abortRef = useRef<AbortController | null>(null);

  const reset = useCallback(() => {
    abortRef.current?.abort();
    setState(INITIAL);
  }, []);

  const send = useCallback(async (message: string) => {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    setState({ text: "", manifest: null, isStreaming: true, error: null });

    try {
      const response = await fetch("/api/query/stream", {
        method: "POST",
        headers: { "content-type": "application/json", accept: "text/event-stream" },
        body: JSON.stringify({ message }),
        signal: controller.signal,
      });
      if (!response.ok || !response.body) {
        throw new Error(`HTTP ${response.status}`);
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
      setState((s) => ({ ...s, isStreaming: false }));
    } catch (err) {
      if (controller.signal.aborted) return;
      setState((s) => ({ ...s, isStreaming: false, error: (err as Error).message }));
    }
  }, []);

  return { ...state, send, reset };
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
