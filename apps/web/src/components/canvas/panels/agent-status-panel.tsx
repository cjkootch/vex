"use client";

import type { ManifestPanel } from "@vex/ui";

type AgentStatusPanelProps = Extract<ManifestPanel, { type: "agent_status" }>;
type Row = AgentStatusPanelProps["rows"][number];

const STATUS_BADGE: Record<Row["status"], string> = {
  pending: "bg-muted/60 text-white/70",
  running: "bg-warn/20 text-warn",
  completed: "bg-good/20 text-good",
  failed: "bg-bad/20 text-bad",
  skipped: "bg-muted/60 text-white/50",
};

const AGENT_LABELS: Record<string, string> = {
  daily_brief: "Daily Brief",
  follow_up: "Follow-up",
  research: "Research",
  analyst: "Analyst",
  call_prep: "Call Prep",
  market_data: "Market Data",
  market_alert: "Market Alert",
  deal_evaluator: "Deal Evaluator",
  outbound_call: "Outbound Call",
  qualifier: "Qualifier",
  composer: "Composer",
};

export function AgentStatusPanel({ title, rows }: AgentStatusPanelProps) {
  const heading = title ?? "Agent status";
  return (
    <section
      data-panel="agent_status"
      className="rounded-lg border border-line bg-muted/40 p-4 space-y-3"
    >
      <header className="flex items-baseline justify-between gap-3">
        <h3 className="text-sm font-semibold uppercase tracking-wider text-white/80">
          {heading}
        </h3>
        <span className="text-xs text-white/40">
          {rows.length} agent{rows.length === 1 ? "" : "s"}
        </span>
      </header>

      <ul className="space-y-1.5">
        {rows.map((r) => (
          <li
            key={r.agentName}
            className="rounded-md border border-line/60 bg-canvas/40 px-3 py-2"
          >
            <div className="flex items-baseline justify-between gap-3">
              <span className="font-mono text-sm text-accent">
                {AGENT_LABELS[r.agentName] ?? r.agentName}
              </span>
              <span
                className={`inline-block rounded px-1.5 py-0.5 text-[11px] uppercase tracking-wide ${STATUS_BADGE[r.status]}`}
              >
                {r.status}
              </span>
            </div>
            <div className="mt-1 flex flex-wrap items-baseline gap-x-4 gap-y-0.5 text-xs text-white/50">
              <span>
                last run{" "}
                <span className="text-white/70">{formatLastRun(r.lastRun)}</span>
              </span>
              <span>
                cost{" "}
                <span className="text-white/70">${r.costUsd.toFixed(4)}</span>
              </span>
            </div>
            {r.error && (
              <div className="mt-1.5 rounded border border-bad/40 bg-bad/10 px-2 py-1 text-xs text-bad">
                {r.error}
              </div>
            )}
            {!r.error && r.summary && (
              <div className="mt-1.5 text-xs text-white/70">{r.summary}</div>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}

function formatLastRun(iso: string | null): string {
  if (!iso) return "never";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const ageMs = Date.now() - d.getTime();
  const mins = Math.floor(ageMs / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 48) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}
