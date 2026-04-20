"use client";

import { useMemo } from "react";
import Link from "next/link";
import type { ManifestPanel } from "@vex/ui";

type Props = Extract<ManifestPanel, { type: "approval_flow" }>;

const TIERS = ["T0", "T1", "T2", "T3"] as const;

type Status = Props["steps"][number]["status"];

function statusStyles(status: Status): { pill: string; dot: string; label: string } {
  switch (status) {
    case "approved":
      return {
        pill: "border-good/40 bg-good/10 text-good",
        dot: "bg-good",
        label: "approved",
      };
    case "auto_approved":
      return {
        pill: "border-good/30 bg-good/5 text-good/80",
        dot: "bg-good/70",
        label: "auto-approved",
      };
    case "rejected":
      return {
        pill: "border-bad/40 bg-bad/10 text-bad",
        dot: "bg-bad",
        label: "rejected",
      };
    case "pending":
      return {
        pill: "border-warn/40 bg-warn/10 text-warn",
        dot: "bg-warn",
        label: "pending",
      };
    case "not_started":
      return {
        pill: "border-line bg-canvas/40 text-white/40",
        dot: "bg-white/20",
        label: "not started",
      };
  }
}

function tierLabel(tier: "T0" | "T1" | "T2" | "T3"): string {
  switch (tier) {
    case "T0":
      return "T0 · Internal read";
    case "T1":
      return "T1 · Auto-write";
    case "T2":
      return "T2 · External action";
    case "T3":
      return "T3 · High-risk";
  }
}

function formatWhen(iso?: string): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  const delta = Date.now() - d.getTime();
  const hours = Math.floor(delta / 3_600_000);
  if (hours < 1) return "just now";
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

export function ApprovalFlowPanel({ title, contextRef, steps }: Props) {
  // Group steps by tier + keep chronological order within each lane.
  const byTier = useMemo(() => {
    const map = new Map<string, Props["steps"]>();
    for (const tier of TIERS) map.set(tier, []);
    for (const s of steps) {
      const lane = map.get(s.tier);
      if (lane) lane.push(s);
    }
    // Stable-sort by occurredAt ascending; undefined sinks to the
    // end so "not started" predicted gates trail behind actual history.
    for (const lane of map.values()) {
      lane.sort((a, b) => {
        if (!a.occurredAt && !b.occurredAt) return 0;
        if (!a.occurredAt) return 1;
        if (!b.occurredAt) return -1;
        return a.occurredAt.localeCompare(b.occurredAt);
      });
    }
    return map;
  }, [steps]);

  // Hide tiers that have no steps AND no "not_started" predicted gates,
  // to keep the chart compact on a simple flow.
  const activeTiers = TIERS.filter((t) => (byTier.get(t)?.length ?? 0) > 0);

  return (
    <section
      data-panel="approval_flow"
      className="overflow-hidden rounded-lg border border-line bg-muted/40"
    >
      <header className="flex items-baseline justify-between border-b border-line px-4 py-3">
        <h3 className="text-sm font-semibold text-white">{title}</h3>
        {contextRef ? (
          <span className="font-mono text-xs text-white/40">{contextRef}</span>
        ) : null}
      </header>
      <div className="overflow-x-auto">
        <div className="min-w-max space-y-2 p-4">
          {activeTiers.length === 0 ? (
            <p className="text-sm text-white/50">No approvals in the flow.</p>
          ) : (
            activeTiers.map((tier) => (
              <div
                key={tier}
                data-testid={`approval-flow-lane-${tier}`}
                className="flex items-start gap-3"
              >
                <div className="w-32 flex-shrink-0 pt-2 text-xs uppercase tracking-wide text-white/40">
                  {tierLabel(tier)}
                </div>
                <div className="flex flex-1 flex-wrap items-center gap-2 border-b border-dashed border-line/40 pb-3">
                  {(byTier.get(tier) ?? []).map((s, i) => {
                    const styles = statusStyles(s.status);
                    const when = formatWhen(s.occurredAt);
                    const pill = (
                      <div
                        data-testid={`approval-flow-step-${s.tier}-${i}`}
                        className={`flex max-w-xs flex-col gap-1 rounded-md border px-3 py-2 text-xs ${styles.pill}`}
                      >
                        <div className="flex items-center gap-1.5">
                          <span className={`h-1.5 w-1.5 rounded-full ${styles.dot}`} />
                          <span className="font-medium">{s.label}</span>
                        </div>
                        <div className="flex items-center gap-2 text-[11px] opacity-80">
                          <span>{styles.label}</span>
                          {s.actionType ? (
                            <span className="font-mono opacity-70">{s.actionType}</span>
                          ) : null}
                          {when ? <span>· {when}</span> : null}
                        </div>
                        {s.reviewer ? (
                          <div className="text-[11px] opacity-70">by {s.reviewer}</div>
                        ) : null}
                        {s.reason ? (
                          <div className="text-[11px] italic opacity-80">“{s.reason}”</div>
                        ) : null}
                        {s.blockers && s.blockers.length > 0 ? (
                          <ul className="mt-0.5 space-y-0.5 text-[11px] text-bad">
                            {s.blockers.map((b, bi) => (
                              <li key={bi}>⚠ {b}</li>
                            ))}
                          </ul>
                        ) : null}
                      </div>
                    );
                    return (
                      <div key={`${tier}-${i}`} className="flex items-center gap-2">
                        {i > 0 ? (
                          <span
                            aria-hidden="true"
                            className="text-white/30"
                          >
                            →
                          </span>
                        ) : null}
                        {s.approvalId ? (
                          <Link
                            href={`/app/approvals?focus=${encodeURIComponent(s.approvalId)}`}
                            className="no-underline"
                          >
                            {pill}
                          </Link>
                        ) : (
                          pill
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>
            ))
          )}
        </div>
      </div>
    </section>
  );
}
