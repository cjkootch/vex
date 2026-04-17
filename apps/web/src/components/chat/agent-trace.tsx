"use client";

import { useEffect, useState } from "react";

export interface AgentRunRow {
  id: string;
  agentName: string;
  status: string;
  startedAt: string;
  completedAt: string | null;
  durationMs?: number | null;
  costUsd?: number | null;
  summary?: string | null;
}

export interface AgentTraceProps {
  /**
   * `Date` (or ISO string) the assistant turn started — only agent
   * runs at or after this point are surfaced. Set this from the
   * timestamp on the user's message that opened the turn so the
   * trace block scopes to the right window.
   */
  since: string | Date;
  /**
   * Optional cap. Defaults to 8 — Meridian shows ~3-5 per turn,
   * 8 covers an investigation-length turn without becoming a wall.
   */
  limit?: number;
}

/**
 * Meridian-style "what did the AI do" trace. Polls /api/agent-runs
 * once on mount and every 6s until the trace stabilises (no new
 * rows for two consecutive ticks). Shows a collapsible header so
 * the trace doesn't compete with the assistant's prose.
 */
export function AgentTrace({ since, limit = 8 }: AgentTraceProps) {
  const sinceIso =
    typeof since === "string" ? since : since.toISOString();
  const [rows, setRows] = useState<AgentRunRow[] | null>(null);
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    let stableTicks = 0;
    let prevCount = -1;

    async function tick(): Promise<boolean> {
      try {
        const qs = new URLSearchParams({
          since: sinceIso,
          limit: String(limit),
        });
        const res = await fetch(`/api/agent-runs?${qs.toString()}`);
        if (!res.ok) throw new Error(`${res.status}`);
        const body = (await res.json()) as { runs?: AgentRunRow[] };
        if (cancelled) return false;
        const next = Array.isArray(body.runs) ? body.runs : [];
        setRows(next);
        if (next.length === prevCount) {
          stableTicks += 1;
        } else {
          stableTicks = 0;
        }
        prevCount = next.length;
        // Stop polling once we've had two stable reads in a row OR
        // every visible run finished — agent-runs are bounded.
        const allDone = next.every(
          (r) => r.status === "completed" || r.status === "failed",
        );
        return stableTicks < 2 && !allDone;
      } catch (e) {
        if (!cancelled) setError((e as Error).message);
        return false;
      }
    }

    let timer: ReturnType<typeof setTimeout> | null = null;
    const loop = async (): Promise<void> => {
      const keepGoing = await tick();
      if (cancelled) return;
      if (keepGoing) {
        timer = setTimeout(() => void loop(), 6000);
      }
    };
    void loop();

    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [sinceIso, limit]);

  if (rows === null || rows.length === 0) return null;

  return (
    <div className="my-2 overflow-hidden rounded-md border border-line bg-canvas/40">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-[10px] uppercase tracking-wider text-white/50 hover:text-white/80"
        aria-expanded={open}
      >
        <span
          className={`inline-block transition-transform ${open ? "rotate-90" : ""}`}
          aria-hidden
        >
          ▸
        </span>
        Agent trace · {rows.length}
        <span className="ml-auto font-mono normal-case tracking-normal text-white/40">
          {summariseDuration(rows)}
        </span>
      </button>
      {open && (
        <ol className="divide-y divide-line/60 border-t border-line/60">
          {rows.map((r) => (
            <li
              key={r.id}
              className="grid grid-cols-[120px_1fr_70px] items-center gap-3 px-3 py-1.5 font-mono text-[11px]"
            >
              <span className={agentToneClass(r.agentName)}>{r.agentName}</span>
              <span className="truncate text-white/70">
                {r.summary ?? statusLabel(r.status)}
              </span>
              <span className="text-right text-white/40">
                {formatDuration(r)}
              </span>
            </li>
          ))}
        </ol>
      )}
      {error && open && (
        <div className="border-t border-line/60 px-3 py-1.5 text-[10px] text-bad">
          trace fetch failed: {error}
        </div>
      )}
    </div>
  );
}

function statusLabel(status: string): string {
  switch (status) {
    case "completed":
      return "ok";
    case "failed":
      return "failed";
    case "running":
      return "running…";
    case "queued":
      return "queued";
    default:
      return status;
  }
}

function formatDuration(r: AgentRunRow): string {
  if (r.durationMs && r.durationMs > 0) {
    return r.durationMs >= 1000
      ? `${(r.durationMs / 1000).toFixed(1)}s`
      : `${Math.round(r.durationMs)}ms`;
  }
  if (r.completedAt && r.startedAt) {
    const ms = new Date(r.completedAt).getTime() - new Date(r.startedAt).getTime();
    if (ms > 0) {
      return ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${ms}ms`;
    }
  }
  return r.status === "running" ? "…" : "—";
}

function summariseDuration(rows: AgentRunRow[]): string {
  let total = 0;
  for (const r of rows) {
    if (r.durationMs && r.durationMs > 0) {
      total += r.durationMs;
    } else if (r.completedAt && r.startedAt) {
      total += Math.max(
        0,
        new Date(r.completedAt).getTime() - new Date(r.startedAt).getTime(),
      );
    }
  }
  if (total === 0) return "";
  return total >= 1000 ? `${(total / 1000).toFixed(1)}s total` : `${total}ms`;
}

const TONE_BY_NAME: Record<string, string> = {
  daily_brief: "text-accent",
  follow_up: "text-warn",
  research: "text-accent",
  deal_evaluator: "text-accent",
  outbound_call: "text-warn",
  qualifier: "text-accent",
  composer: "text-accent",
};

function agentToneClass(name: string): string {
  return TONE_BY_NAME[name] ?? "text-white/80";
}
