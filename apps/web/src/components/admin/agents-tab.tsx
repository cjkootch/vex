"use client";

import { useState } from "react";
import type { WorkspaceSettings } from "./admin-console";

interface AgentDescriptor {
  name: string;
  label: string;
  description: string;
  tier: "T0" | "T1" | "T2" | "T3";
}

// Canonical agent registry — matches the names the runner constructs.
// Keeping this hard-coded means enabling a new agent is a single
// intentional edit rather than a free-form text field.
const KNOWN_AGENTS: AgentDescriptor[] = [
  { name: "daily_brief", label: "Daily Brief", tier: "T0",
    description: "Morning summary with priorities + pipeline + risks." },
  { name: "research", label: "Research", tier: "T1",
    description: "Researches organizations and updates fit scores." },
  { name: "follow_up", label: "Follow-up", tier: "T1",
    description: "Drafts outreach suggestions for stale threads + leads." },
  { name: "call_prep", label: "Call Prep", tier: "T2",
    description: "Prepares a brief before a scheduled call." },
  { name: "deal_evaluator", label: "Deal Evaluator", tier: "T1",
    description: "Recomputes the fuel-deal scorecard on create / update." },
  { name: "marketing_analyst", label: "Marketing Analyst", tier: "T0",
    description: "Hourly GA4 anomaly scan + marketing overview summary." },
  { name: "outbound_call", label: "Outbound Call", tier: "T3",
    description: "Places outbound PSTN calls (T3 — every call requires owner approval)." },
];

export interface AgentsTabProps {
  settings: WorkspaceSettings | null;
  onPatch: (patch: Partial<WorkspaceSettings>) => Promise<boolean>;
}

export function AgentsTab({ settings, onPatch }: AgentsTabProps) {
  if (!settings) return <p className="text-sm text-white/50">Loading settings…</p>;

  const enabled = new Set(settings.enabled_agents);

  const toggleAgent = async (name: string): Promise<void> => {
    const next = new Set(enabled);
    if (next.has(name)) next.delete(name);
    else next.add(name);
    await onPatch({ enabled_agents: Array.from(next).sort() });
  };

  return (
    <section className="space-y-8">
      <KillSwitchBlock settings={settings} onPatch={onPatch} />
      <CostLimitBlock settings={settings} onPatch={onPatch} />

      <div>
        <h2 className="mb-3 text-sm font-semibold uppercase tracking-wider text-white/70">
          Agents
        </h2>
        <ul className="divide-y divide-line/60 rounded-lg border border-line bg-muted/20">
          {KNOWN_AGENTS.map((agent) => (
            <li
              key={agent.name}
              data-agent={agent.name}
              className="flex items-start justify-between gap-4 px-4 py-3"
            >
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="font-medium text-white">{agent.label}</span>
                  <span className="rounded bg-white/10 px-1.5 py-0.5 font-mono text-xs text-white/70">
                    {agent.tier}
                  </span>
                </div>
                <p className="mt-1 text-xs text-white/60">{agent.description}</p>
              </div>
              <Toggle
                checked={enabled.has(agent.name)}
                onChange={() => void toggleAgent(agent.name)}
                label={`Enable ${agent.label}`}
              />
            </li>
          ))}
        </ul>
      </div>

      <SourcePriorityBlock settings={settings} onPatch={onPatch} />
    </section>
  );
}

function KillSwitchBlock({
  settings,
  onPatch,
}: {
  settings: WorkspaceSettings;
  onPatch: AgentsTabProps["onPatch"];
}) {
  const [confirming, setConfirming] = useState(false);
  const engage = async (): Promise<void> => {
    await onPatch({ kill_all_agents: true });
    setConfirming(false);
  };
  const release = async (): Promise<void> => {
    await onPatch({ kill_all_agents: false });
  };
  const isOn = settings.kill_all_agents === true;
  return (
    <div
      data-block="kill-switch"
      className={`rounded-lg border p-4 ${
        isOn
          ? "border-red-500/60 bg-red-500/10"
          : "border-line bg-muted/20"
      }`}
    >
      <header className="flex items-start justify-between gap-4">
        <div>
          <h2 className="text-sm font-semibold uppercase tracking-wider text-white">
            Kill switch
          </h2>
          <p className="mt-1 text-xs text-white/70">
            Halts every T1+ agent within one job cycle. T0 read-only
            agents (daily brief) keep running for health.
          </p>
        </div>
        {isOn ? (
          <span className="rounded-full border border-red-500/50 bg-red-500/20 px-2 py-0.5 text-xs text-red-200">
            ENGAGED
          </span>
        ) : null}
      </header>
      <div className="mt-3">
        {isOn ? (
          <button
            type="button"
            onClick={() => void release()}
            className="rounded-md border border-red-500/50 bg-red-500/20 px-3 py-1.5 text-sm text-red-100 transition hover:bg-red-500/30"
          >
            Release kill switch
          </button>
        ) : confirming ? (
          <span className="inline-flex items-center gap-2 text-sm">
            <span className="text-white/70">
              Stop every T1+ agent across the workspace?
            </span>
            <button
              type="button"
              onClick={() => void engage()}
              className="rounded-md bg-red-500 px-3 py-1.5 text-white hover:bg-red-400"
            >
              Engage
            </button>
            <button
              type="button"
              onClick={() => setConfirming(false)}
              className="rounded-md border border-line bg-transparent px-3 py-1.5 text-white/70 hover:bg-white/5"
            >
              Cancel
            </button>
          </span>
        ) : (
          <button
            type="button"
            onClick={() => setConfirming(true)}
            className="rounded-md border border-red-500/40 bg-red-500/5 px-3 py-1.5 text-sm text-red-200 transition hover:bg-red-500/10"
          >
            Engage kill switch
          </button>
        )}
      </div>
    </div>
  );
}

function CostLimitBlock({
  settings,
  onPatch,
}: {
  settings: WorkspaceSettings;
  onPatch: AgentsTabProps["onPatch"];
}) {
  const [value, setValue] = useState<string>(
    settings.daily_cost_limit.toFixed(2),
  );
  const [status, setStatus] = useState<"idle" | "saving" | "saved" | "error">(
    "idle",
  );
  const save = async (): Promise<void> => {
    const parsed = Number.parseFloat(value);
    if (!Number.isFinite(parsed) || parsed < 0) {
      setStatus("error");
      return;
    }
    setStatus("saving");
    const ok = await onPatch({ daily_cost_limit: parsed });
    setStatus(ok ? "saved" : "error");
  };
  return (
    <div className="rounded-lg border border-line bg-muted/20 p-4">
      <h2 className="text-sm font-semibold uppercase tracking-wider text-white">
        Daily cost cap
      </h2>
      <p className="mt-1 text-xs text-white/60">
        Stops T1+ agents when today&rsquo;s spend hits this dollar amount.
        T0 agents are exempt.
      </p>
      <div className="mt-3 flex items-center gap-2">
        <span className="text-white/60">$</span>
        <input
          type="number"
          min={0}
          step="0.25"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          aria-label="Daily cost limit in USD"
          className="w-28 rounded-md border border-line bg-canvas/40 px-2 py-1 text-sm text-white focus:border-white/30 focus:outline-none"
        />
        <button
          type="button"
          onClick={() => void save()}
          className="rounded-md border border-line bg-muted/40 px-3 py-1 text-sm text-white/80 transition hover:border-white/30 hover:text-white"
        >
          Save
        </button>
        {status === "saved" ? (
          <span className="text-xs text-emerald-300">Saved.</span>
        ) : null}
        {status === "error" ? (
          <span className="text-xs text-red-300">Invalid or save failed.</span>
        ) : null}
      </div>
    </div>
  );
}

function SourcePriorityBlock({
  settings,
  onPatch,
}: {
  settings: WorkspaceSettings;
  onPatch: AgentsTabProps["onPatch"];
}) {
  const [order, setOrder] = useState<string[]>(settings.source_priority);
  const move = (index: number, delta: number): void => {
    const target = index + delta;
    if (target < 0 || target >= order.length) return;
    const copy = order.slice();
    const [item] = copy.splice(index, 1);
    copy.splice(target, 0, item!);
    setOrder(copy);
  };
  const save = async (): Promise<void> => {
    await onPatch({ source_priority: order });
  };
  return (
    <div>
      <h2 className="mb-3 text-sm font-semibold uppercase tracking-wider text-white/70">
        Source priority
      </h2>
      <p className="mb-3 text-xs text-white/60">
        Higher in the list wins a field-level merge conflict. Reorder with
        the arrows, then save.
      </p>
      <ul className="space-y-1" data-block="source-priority">
        {order.map((source, i) => (
          <li
            key={source}
            className="flex items-center justify-between rounded-md border border-line bg-muted/20 px-3 py-2 text-sm"
          >
            <span className="font-mono text-white">{source}</span>
            <span className="flex items-center gap-1">
              <button
                type="button"
                onClick={() => move(i, -1)}
                disabled={i === 0}
                aria-label={`Move ${source} up`}
                className="rounded px-2 py-0.5 text-white/60 hover:bg-white/5 hover:text-white disabled:opacity-30"
              >
                ↑
              </button>
              <button
                type="button"
                onClick={() => move(i, 1)}
                disabled={i === order.length - 1}
                aria-label={`Move ${source} down`}
                className="rounded px-2 py-0.5 text-white/60 hover:bg-white/5 hover:text-white disabled:opacity-30"
              >
                ↓
              </button>
            </span>
          </li>
        ))}
      </ul>
      <button
        type="button"
        onClick={() => void save()}
        className="mt-3 rounded-md border border-line bg-muted/40 px-3 py-1 text-sm text-white/80 transition hover:border-white/30 hover:text-white"
      >
        Save order
      </button>
    </div>
  );
}

function Toggle({
  checked,
  onChange,
  label,
}: {
  checked: boolean;
  onChange: () => void;
  label: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      onClick={onChange}
      className={`relative inline-flex h-6 w-11 flex-shrink-0 items-center rounded-full transition-colors ${
        checked ? "bg-emerald-500" : "bg-white/10"
      }`}
    >
      <span
        aria-hidden="true"
        className={`inline-block h-5 w-5 rounded-full bg-white transition-transform ${
          checked ? "translate-x-5" : "translate-x-0.5"
        }`}
      />
    </button>
  );
}
