"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

/**
 * Home-page section that rolls up the workspace-pulse signal and
 * surfaces the 3–5 deals that most need the operator's attention
 * right now. Blocked deals float above at-risk; within each group
 * older-updatedAt sorts first (most stale blocker wins the top
 * slot).
 *
 * Pure read — clicking a row jumps to the deal's detail page where
 * the full PulseBand + Readiness tab give the detail.
 */

interface PulseDeal {
  dealId: string;
  dealRef: string;
  status: string;
  product: string;
  buyerName: string | null;
  volumeUsg: number;
  volumeUnit: string;
  urgency: "blocked" | "at_risk" | "stale" | "healthy";
  blockers: Array<{ kind: string; detail: string }>;
  attention: Array<{ kind: string; detail: string }>;
  nextAction: string | null;
  ageDays: number;
}

interface PulseResponse {
  deals: PulseDeal[];
  summary: {
    blocked: number;
    at_risk: number;
    stale: number;
    healthy: number;
  };
}

const MAX_ROWS = 5;

export function DealsNeedingAttention(): React.ReactElement | null {
  const [data, setData] = useState<PulseResponse | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch(`/api/deals/workspace-pulse`)
      .then(async (r) => {
        if (!r.ok) throw new Error(String(r.status));
        return r.json();
      })
      .then((body: PulseResponse) => {
        if (!cancelled) setData(body);
      })
      .catch(() => {
        // Section is supplementary; stay quiet on fetch failure.
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (!data) return null;
  const urgent = data.deals
    .filter((d) => d.urgency === "blocked" || d.urgency === "at_risk")
    .sort((a, b) => {
      if (a.urgency !== b.urgency) return a.urgency === "blocked" ? -1 : 1;
      return b.ageDays - a.ageDays;
    })
    .slice(0, MAX_ROWS);
  if (urgent.length === 0) return null;

  return (
    <section aria-label="Deals needing attention" className="flex flex-col gap-3">
      <header className="flex items-baseline justify-between gap-3">
        <div className="flex items-baseline gap-2">
          <h2 className="text-eyebrow text-text-secondary">
            Deals needing attention
          </h2>
          <span className="num text-xs text-text-muted">
            · {data.summary.blocked} blocked · {data.summary.at_risk} at risk
          </span>
        </div>
        <Link
          href="/app/deals"
          className="text-xs text-text-muted transition-colors hover:text-text-secondary"
        >
          Full cockpit →
        </Link>
      </header>
      <ul className="flex flex-col gap-2">
        {urgent.map((d) => (
          <DealAttentionRow key={d.dealId} deal={d} />
        ))}
      </ul>
    </section>
  );
}

function DealAttentionRow({ deal }: { deal: PulseDeal }) {
  const primary =
    deal.blockers[0]?.detail ?? deal.attention[0]?.detail ?? null;
  const isBlocked = deal.urgency === "blocked";
  const border = isBlocked
    ? "border-bad/40 bg-bad/[0.05]"
    : "border-warn/40 bg-warn/[0.05]";
  const eyebrowTone = isBlocked ? "text-bad" : "text-warn";
  const dotTone = isBlocked ? "bg-bad" : "bg-warn";
  return (
    <li>
      <Link
        href={`/app/deals/${deal.dealId}`}
        className={`hover-lift flex flex-col gap-1 rounded-lg border px-4 py-3 ${border}`}
      >
        <div className="flex flex-wrap items-baseline gap-2">
          <span
            aria-hidden="true"
            className={`inline-block h-1.5 w-1.5 rounded-full ${dotTone} shadow-[0_0_6px_currentColor]`}
          />
          <span className={`text-eyebrow ${eyebrowTone}`}>
            {isBlocked ? "Blocked" : "At risk"}
          </span>
          <span className="num-mono text-sm font-semibold text-text-primary">
            {deal.dealRef}
          </span>
          <span className="text-xs text-text-secondary">
            {deal.product.replace(/_/g, " ")}
          </span>
          {deal.buyerName ? (
            <>
              <span className="text-xs text-text-muted">·</span>
              <span className="truncate text-xs text-text-secondary">
                {deal.buyerName}
              </span>
            </>
          ) : null}
          <span className="ml-auto num text-[11px] text-text-muted">
            {deal.ageDays === 0 ? "today" : `${deal.ageDays}d`}
          </span>
        </div>
        {primary ? (
          <div className="ml-3.5 text-xs text-text-secondary/90">{primary}</div>
        ) : null}
        {deal.nextAction ? (
          <div className="ml-3.5 text-xs">
            <span className="text-eyebrow text-accent-strong mr-1.5">Next</span>
            <span className="text-text-primary/90">{deal.nextAction}</span>
          </div>
        ) : null}
      </Link>
    </li>
  );
}
