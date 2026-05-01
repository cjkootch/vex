"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { formatDistanceToNow } from "date-fns";
import { vexCopy } from "@vex/ui";
import { buildAskVexHref, type AskVexSubjectType } from "@/lib/ask-vex";

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
 *
 * When a `scope` is passed, the query adds `scope_type` + `scope_id`
 * so the rail only lists runs that touched the entity in view — the
 * rail becomes a "what did Vex just do to this deal / contact / org"
 * timeline instead of a global activity log. Unscoped callers keep
 * the global behaviour.
 */
function useAgentRuns(scope: AutonomyScope | null): {
  runs: AgentRunItem[] | null;
  error: string | null;
} {
  const [runs, setRuns] = useState<AgentRunItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const scopeType = scope?.type ?? "";
  const scopeId = scope?.id ?? "";
  useEffect(() => {
    let cancelled = false;
    // Rebuild the URL every poll so scope changes land immediately —
    // closing over the current scope via deps below.
    const buildUrl = (): string => {
      const params = new URLSearchParams();
      params.set("limit", "20");
      params.set("tenant_id", "current");
      if (scopeType && scopeId) {
        params.set("scope_type", scopeType);
        params.set("scope_id", scopeId);
      }
      return `/api/agent-runs?${params.toString()}`;
    };
    const tick = async (): Promise<void> => {
      try {
        const res = await fetch(buildUrl(), {
          credentials: "include",
          cache: "no-store",
        });
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
    // Reset while scope changes so the old list doesn't flash.
    setRuns(null);
    void tick();
    const interval = setInterval(() => void tick(), POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [scopeType, scopeId]);
  return { runs, error };
}

export interface AutonomyScope {
  type: AskVexSubjectType;
  id: string;
  label: string;
}

/**
 * Heuristic: when scoped, surface 2-4 one-click prompts that
 * correspond to the things an operator most often asks Vex from the
 * current page. These read as "Vex suggests" rather than "run this
 * command" — click opens chat with the prompt pre-filled.
 */
function suggestionsFor(scope: AutonomyScope): AskSuggestion[] {
  switch (scope.type) {
    case "deal":
      return [
        {
          label: "Check readiness to ship",
          ask: `For deal ${scope.label}, walk me through KYC, OFAC, counterparty approval, freight freshness, vessel, payment terms, docs, and next milestone owner. Tell me what's blocking.`,
        },
        {
          label: "Score this deal",
          ask: `Score deal ${scope.label} and explain the EBITDA / margin drivers.`,
        },
        {
          label: "Summarise recent activity",
          ask: `Summarise the last 14 days of activity on deal ${scope.label}.`,
        },
      ];
    case "organization":
      return [
        {
          label: "Counterparty snapshot",
          ask: `Give me a snapshot of ${scope.label}: OFAC status, open deals, recent touchpoints, key contacts, risk signals.`,
        },
        {
          label: "Research & enrich",
          ask: `Research ${scope.label}: ownership, leadership, public news, anything relevant to trading with them.`,
        },
        {
          label: "Re-screen OFAC",
          ask: `Re-run OFAC screening on ${scope.label} and tell me if anything changed.`,
        },
      ];
    case "contact":
      return [
        {
          label: "Who is this?",
          ask: `Summarise ${scope.label}: role, company, last touchpoint, open deals.`,
        },
        {
          label: "Re-enrich from web",
          ask: `Re-enrich ${scope.label} from the public web — refresh title, email, phone, LinkedIn URL, and primary language from current sources.`,
        },
        {
          label: "Call them (AI mode)",
          ask: `Have Vex call ${scope.label} to check in on their open business with us.`,
        },
        {
          label: "Draft email",
          ask: `Draft a short email to ${scope.label} — pick the right topic based on our recent activity with them.`,
        },
      ];
    case "campaign":
      return [
        {
          label: "Campaign health",
          ask: `How is campaign ${scope.label} performing? Engagement, reply rate, bounces, what's stuck.`,
        },
        {
          label: "Draft next step",
          ask: `Draft the next step for campaign ${scope.label} — pick the channel and the hook.`,
        },
      ];
  }
}

interface AskSuggestion {
  label: string;
  ask: string;
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

export function AutonomyFeed({
  scope,
}: { scope?: AutonomyScope | null } = {}) {
  const { runs, error } = useAgentRuns(scope ?? null);

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

  const suggestions = scope ? suggestionsFor(scope) : null;

  return (
    <div className="flex h-full flex-col">
      {scope ? (
        <div className="border-b border-line-soft bg-surface-2/60 px-3 py-2.5">
          <div className="text-eyebrow text-text-muted">Scoped to</div>
          <div className="mt-0.5 flex items-center gap-2 text-xs">
            <span
              aria-hidden="true"
              className="inline-block h-1.5 w-1.5 rounded-full bg-accent shadow-[0_0_6px_currentColor]"
            />
            <span className="truncate font-medium text-text-primary">
              {scope.label}
            </span>
            <span className="text-text-muted">· {scope.type}</span>
          </div>
        </div>
      ) : null}
      {suggestions && suggestions.length > 0 ? (
        <div className="relative border-b border-line-soft bg-intel-soft/30 px-2 py-2.5">
          <div className="mb-1.5 flex items-center gap-1.5 px-1">
            <span
              aria-hidden="true"
              className="h-1.5 w-1.5 rounded-full bg-accent shadow-[0_0_6px_currentColor]"
            />
            <span className="text-eyebrow text-accent-strong">
              Vex suggests
            </span>
          </div>
          <ul className="flex flex-col gap-1">
            {suggestions.map((s) => (
              <li key={s.label}>
                <Link
                  href={buildAskVexHref({
                    type: scope!.type,
                    id: scope!.id,
                    label: scope!.label,
                    ask: s.ask,
                  })}
                  className="group flex items-center justify-between rounded-md px-2 py-1.5 text-xs text-text-secondary transition-colors hover:bg-white/[0.04] hover:text-text-primary"
                >
                  <span>{s.label}</span>
                  <span
                    aria-hidden="true"
                    className="text-accent-strong transition-transform group-hover:translate-x-0.5"
                  >
                    →
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      <div className="flex-1 overflow-auto px-3 py-2">
        {runs === null && error === null ? (
          <SkeletonRows />
        ) : runs === null && error !== null ? (
          <p className="px-1 py-4 text-sm text-red-400">
            Feed unavailable: {error}
          </p>
        ) : sections.length === 0 ? (
          <p className="px-1 py-4 text-sm text-white/60">
            {scope
              ? `Vex hasn't run anything on ${scope.label} yet.`
              : "Vex is idle. Agents run on schedule."}
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
    <li className="rounded-md border border-transparent px-2 py-2 text-sm transition-colors duration-150 hover:border-line-soft hover:bg-white/[0.03]">
      <div className="flex items-start gap-2">
        <span
          aria-hidden="true"
          className={`mt-1.5 h-1.5 w-1.5 flex-shrink-0 rounded-full ${STATUS_DOT[run.status]}`}
        />
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline gap-2">
            <span className="rounded bg-surface-2 px-1.5 py-0.5 text-[11px] font-medium text-text-secondary">
              {agentLabel(run.agentName)}
            </span>
            <span className="num truncate text-[11px] text-text-muted">
              {formatDistanceToNow(new Date(run.startedAt), {
                addSuffix: true,
              })}
            </span>
            <span className="num ml-auto text-[11px] text-text-muted">
              {formatCost(run.costUsd)}
            </span>
          </div>
          <p className="mt-1 line-clamp-2 text-xs text-text-secondary">
            {run.summary}
          </p>
          {needsApproval ? (
            <Link
              href="/app/approvals"
              className="mt-1 inline-block text-xs font-medium text-amber-300 transition-colors hover:text-amber-200"
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
