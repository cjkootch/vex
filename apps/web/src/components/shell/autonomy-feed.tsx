"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { formatDistanceToNow } from "date-fns";
import { vexCopy } from "@vex/ui";

/**
 * Right-rail autonomy feed — what Vex has been doing for you in the
 * background. Polls GET /api/agent-runs?limit=20&tenant_id=current
 * every 30s, groups runs by lifecycle phase so "Needs attention" is
 * always at the top, and shows a running cost-today footer.
 *
 * Part 2 (see continuation) will add AutonomyRow + SkeletonRows; this
 * file won't typecheck standalone until that lands.
 */

interface AgentRunItem {
  id: string;
  agentName: string;
  status: "completed" | "failed" | "pending" | "running" | "skipped";
  summary: string;
  startedAt: string;
  costUsd: number;
  hasApproval: boolean;
  approvalStatus?: "pending" | "approved" | "rejected";
}

type GroupKey = "attention" | "in_progress" | "completed" | "earlier";

const POLL_INTERVAL_MS = 30_000;
const FOUR_HOURS_MS = 4 * 60 * 60 * 1000;

// Prettified agent labels; unknown names fall back to title-cased snake_case.
const AGENT_LABELS: Record<string, string> = {
  daily_brief: "Daily Brief",
  research: "Research",
  follow_up: "Follow-up",
  call_prep: "Call Prep",
  deal_evaluator: "Deal Evaluator",
  marketing_analyst: "Marketing",
};

const STATUS_DOT: Record<AgentRunItem["status"], string> = {
  completed: "bg-emerald-400",
  failed: "bg-red-500",
  pending: "bg-amber-400",
  running: "bg-blue-400 animate-pulse",
  skipped: "bg-white/30",
};

const GROUP_TONE: Record<GroupKey, { label: string; className: string }> = {
  attention: { label: "Needs attention", className: "text-red-400" },
  in_progress: { label: "In progress", className: "text-blue-400" },
  completed: { label: "Completed", className: "text-emerald-400" },
  earlier: { label: "Earlier", className: "text-white/50" },
};

/**
 * Poll the agent-runs endpoint. Tolerant of `AgentRunItem[]` or
 * `{ runs: AgentRunItem[] }` response shapes. Network errors stash the
 * latest message without blanking the previously-rendered data.
 */
function useAgentRuns(): {
  runs: AgentRunItem[] | null;
  error: string | null;
} {
  const [runs, setRuns] = useState<AgentRunItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    const tick = async (): Promise<void> => {
      try {
        const res = await fetch(
          "/api/agent-runs?limit=20&tenant_id=current",
          { credentials: "include", cache: "no-store" },
        );
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = (await res.json()) as
          | AgentRunItem[]
          | { runs?: AgentRunItem[] };
        if (cancelled) return;
        setRuns(Array.isArray(data) ? data : (data.runs ?? []));
        setError(null);
      } catch (e) {
        if (cancelled) return;
        setError((e as Error).message);
      }
    };
    void tick();
    const interval = setInterval(() => void tick(), POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, []);
  return { runs, error };
}

function groupOf(run: AgentRunItem): GroupKey {
  if (run.status === "failed") return "attention";
  if (run.hasApproval && run.approvalStatus === "pending") return "attention";
  if (run.status === "running" || run.status === "pending") return "in_progress";
  if (run.status === "completed") {
    const age = Date.now() - new Date(run.startedAt).getTime();
    return age <= FOUR_HOURS_MS ? "completed" : "earlier";
  }
  return "earlier";
}

function agentLabel(name: string): string {
  const known = AGENT_LABELS[name];
  if (known) return known;
  return name
    .split("_")
    .map((w) => (w.length ? w.charAt(0).toUpperCase() + w.slice(1) : w))
    .join(" ");
}

function formatCost(usd: number): string {
  if (usd <= 0) return "$0.00";
  if (usd < 0.01) return "<$0.01";
  return `$${usd.toFixed(2)}`;
}

export function AutonomyFeed() {
  const { runs, error } = useAgentRuns();

  const sections = useMemo(() => {
    const order: GroupKey[] = [
      "attention",
      "in_progress",
      "completed",
      "earlier",
    ];
    const buckets: Record<GroupKey, AgentRunItem[]> = {
      attention: [],
      in_progress: [],
      completed: [],
      earlier: [],
    };
    for (const run of runs ?? []) buckets[groupOf(run)].push(run);
    return order
      .map((key) => ({ key, tone: GROUP_TONE[key], items: buckets[key] }))
      .filter((s) => s.items.length > 0);
  }, [runs]);

  const spentToday = useMemo(() => {
    if (!runs) return null;
    const start = new Date();
    start.setHours(0, 0, 0, 0);
    const startMs = start.getTime();
    let sum = 0;
    let n = 0;
    for (const run of runs) {
      if (new Date(run.startedAt).getTime() >= startMs) {
        sum += run.costUsd;
        n++;
      }
    }
    return { sum, n };
  }, [runs]);

  return (
    <div className="flex h-full flex-col">
      <div className="flex-1 overflow-auto px-3 py-2">
        {runs === null && error === null ? (
          <SkeletonRows />
        ) : runs === null && error !== null ? (
          <p className="px-1 py-4 text-sm text-red-400">
            Feed unavailable: {error}
          </p>
        ) : sections.length === 0 ? (
          <p className="px-1 py-4 text-sm text-white/60">
            Vex is idle. Agents run on schedule.
          </p>
        ) : (
          sections.map(({ key, tone, items }) => (
            <section key={key} className="mb-4">
              <h3
                className={`mb-1 px-1 text-xs font-medium uppercase tracking-wider ${tone.className}`}
              >
                {tone.label}
              </h3>
              <ul className="space-y-1">
                {items.map((run) => (
                  <AutonomyRow key={run.id} run={run} />
                ))}
              </ul>
            </section>
          ))
        )}
      </div>
      {spentToday !== null && spentToday.n > 0 ? (
        <footer className="border-t border-line px-3 py-2 text-xs text-white/50">
          Spent ${spentToday.sum.toFixed(2)} today across {spentToday.n}{" "}
          {spentToday.n === 1 ? "run" : "runs"}
        </footer>
      ) : null}
    </div>
  );
}

function AutonomyRow({ run }: { run: AgentRunItem }) {
  const needsApproval =
    run.hasApproval && run.approvalStatus === "pending";
  return (
    <li className="rounded-md border border-transparent px-2 py-2 text-sm transition hover:border-line hover:bg-white/5">
      <div className="flex items-start gap-2">
        <span
          aria-hidden="true"
          className={`mt-1.5 h-2 w-2 flex-shrink-0 rounded-full ${STATUS_DOT[run.status]}`}
        />
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline gap-2">
            <span className="rounded-sm bg-white/10 px-1.5 py-0.5 text-xs text-white/80">
              {agentLabel(run.agentName)}
            </span>
            <span className="truncate text-xs text-white/40">
              {formatDistanceToNow(new Date(run.startedAt), {
                addSuffix: true,
              })}
            </span>
            <span className="ml-auto text-xs text-white/30">
              {formatCost(run.costUsd)}
            </span>
          </div>
          <p className="mt-1 line-clamp-2 text-xs text-white/70">
            {run.summary}
          </p>
          {needsApproval ? (
            <Link
              href="/app/approvals"
              className="mt-1 inline-block text-xs text-amber-300 hover:text-amber-200"
            >
              {vexCopy.approvals.needs_attention} →
            </Link>
          ) : null}
        </div>
      </div>
    </li>
  );
}

function SkeletonRows() {
  return (
    <div className="space-y-2" aria-hidden="true">
      {[0, 1, 2].map((i) => (
        <div key={i} className="flex items-start gap-2 rounded-md px-2 py-2">
          <div className="mt-1.5 h-2 w-2 flex-shrink-0 rounded-full bg-white/10" />
          <div className="flex-1 space-y-1.5">
            <div className="h-3 w-1/3 rounded bg-white/10" />
            <div className="h-3 w-4/5 rounded bg-white/10" />
          </div>
        </div>
      ))}
    </div>
  );
}
