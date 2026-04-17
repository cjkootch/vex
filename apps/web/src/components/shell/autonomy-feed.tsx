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
