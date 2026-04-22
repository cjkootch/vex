"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

/**
 * Global banner that surfaces approvals whose side-effect never
 * ran. If an approval is auto_approved or approved but the executor
 * didn't apply it within 60 seconds, it usually means the worker is
 * down, the Temporal workflow is stuck, or a gate silently rejected
 * the action. Before this banner, operators had to grep `fly logs`
 * to discover the call they triggered never actually dialled.
 *
 * Polls /api/approvals/stalled every 15s. Dismissible per-session;
 * stale rows matching an ID the user dismissed are hidden.
 */

interface StalledApproval {
  id: string;
  actionType: string;
  decision: string;
  decidedAt: string;
  agoSeconds: number;
  workflowId: string | null;
}

const POLL_MS = 15_000;

export function StalledApprovalsBanner(): React.ReactElement | null {
  const [rows, setRows] = useState<StalledApproval[]>([]);
  const [dismissed, setDismissed] = useState<Set<string>>(new Set());

  useEffect(() => {
    let cancelled = false;
    const load = () => {
      fetch(`/api/approvals/stalled`)
        .then(async (res) => {
          if (!res.ok) throw new Error(String(res.status));
          return res.json();
        })
        .then((body: { approvals?: StalledApproval[] }) => {
          if (!cancelled) setRows(body.approvals ?? []);
        })
        .catch(() => {
          /* keep last known state — banner shouldn't error-spam */
        });
    };
    load();
    const t = setInterval(load, POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, []);

  const visible = rows.filter((r) => !dismissed.has(r.id));
  if (visible.length === 0) return null;

  return (
    <div className="flex items-center justify-between gap-3 border-b border-bad/40 bg-bad/[0.08] px-4 py-2 text-xs text-bad">
      <div className="flex items-center gap-2">
        <span
          aria-hidden="true"
          className="inline-block h-1.5 w-1.5 rounded-full bg-bad shadow-[0_0_6px_currentColor]"
        />
        <span className="font-semibold">
          {visible.length} approval{visible.length === 1 ? "" : "s"} stalled
        </span>
        <span className="text-bad/80">
          — approved but not applied. Worker may be down or workflow stuck.
        </span>
      </div>
      <div className="flex items-center gap-2">
        {visible.slice(0, 3).map((r) => {
          const linkTarget = r.workflowId
            ? `/app/calls/${r.workflowId}/debug`
            : `/app/approvals/${r.id}`;
          return (
            <Link
              key={r.id}
              href={linkTarget}
              className="num-mono rounded border border-bad/50 bg-bad/15 px-2 py-0.5 text-[11px] font-medium text-bad transition-colors hover:border-bad/70 hover:bg-bad/25"
              title={`${r.actionType} — ${r.agoSeconds}s ago`}
            >
              {r.actionType} · {formatAgo(r.agoSeconds)}
            </Link>
          );
        })}
        <button
          type="button"
          onClick={() => {
            setDismissed((prev) => {
              const next = new Set(prev);
              for (const r of visible) next.add(r.id);
              return next;
            });
          }}
          className="rounded p-0.5 text-bad/70 transition-colors hover:bg-bad/15 hover:text-bad"
          aria-label="Dismiss"
        >
          ✕
        </button>
      </div>
    </div>
  );
}

function formatAgo(sec: number): string {
  if (sec < 60) return `${sec}s`;
  if (sec < 3600) return `${Math.floor(sec / 60)}m`;
  return `${Math.floor(sec / 3600)}h`;
}
