"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

/**
 * Deal cockpit — the "which deals need attention right now" view that
 * sits above the full deals table. Rolls up every open deal into four
 * urgency groups (Blocked / At Risk / Stale / Healthy) using the
 * workspace-pulse endpoint. Each row carries the primary blocker or
 * attention item plus a one-line next-action hint so the operator
 * can scan top-to-bottom and know what to do next.
 *
 * Designed as a summary surface, not a replacement for the table —
 * sits above it, collapses the healthy group by default, only shows
 * non-empty groups. If everything is healthy, the cockpit shrinks to
 * a single status line ("All N open deals healthy").
 */

interface PulseDeal {
  dealId: string;
  dealRef: string;
  status: string;
  product: string;
  buyerName: string | null;
  buyerOrgId: string;
  volumeUsg: number;
  volumeUnit: string;
  updatedAt: string;
  ageDays: number;
  urgency: "blocked" | "at_risk" | "stale" | "healthy";
  blockers: Array<{ kind: string; detail: string }>;
  attention: Array<{ kind: string; detail: string }>;
  nextAction: string | null;
}

interface PulseResponse {
  generatedAt: string;
  deals: PulseDeal[];
  summary: {
    blocked: number;
    at_risk: number;
    stale: number;
    healthy: number;
  };
}

const GROUP_META: Record<
  PulseDeal["urgency"],
  {
    title: string;
    dotClass: string;
    borderClass: string;
    headerTone: string;
  }
> = {
  blocked: {
    title: "Blocked",
    dotClass: "bg-bad shadow-[0_0_6px_currentColor]",
    borderClass: "border-bad/40",
    headerTone: "text-bad",
  },
  at_risk: {
    title: "At risk",
    dotClass: "bg-warn shadow-[0_0_6px_currentColor]",
    borderClass: "border-warn/40",
    headerTone: "text-warn",
  },
  stale: {
    title: "Stale",
    dotClass: "bg-text-muted/70",
    borderClass: "border-line-soft",
    headerTone: "text-text-secondary",
  },
  healthy: {
    title: "Healthy",
    dotClass: "bg-emerald-400",
    borderClass: "border-line-soft",
    headerTone: "text-emerald-300",
  },
};

export function DealCockpit(): React.ReactElement | null {
  const [data, setData] = useState<PulseResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showHealthy, setShowHealthy] = useState(false);

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
      .catch((err: Error) => {
        if (!cancelled) setError(err.message);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (error) return null;
  if (!data) return <CockpitSkeleton />;
  if (data.deals.length === 0) return null;

  const groups: Array<[PulseDeal["urgency"], PulseDeal[]]> = (
    ["blocked", "at_risk", "stale", "healthy"] as const
  ).map((k) => [k, data.deals.filter((d) => d.urgency === k)]);

  const hasUrgent = data.summary.blocked + data.summary.at_risk > 0;
  const totalOpen = data.deals.length;

  if (!hasUrgent && data.summary.stale === 0) {
    return (
      <section className="flex items-center gap-3 rounded-lg border border-emerald-400/30 bg-emerald-400/[0.06] px-4 py-3 text-sm">
        <span
          aria-hidden="true"
          className="inline-block h-1.5 w-1.5 rounded-full bg-emerald-400 shadow-[0_0_6px_currentColor]"
        />
        <span className="text-emerald-300">All {totalOpen} open deals healthy.</span>
        <span className="text-text-muted">No blockers, no attention items.</span>
      </section>
    );
  }

  return (
    <section
      aria-label="Deal cockpit"
      className="flex flex-col gap-4 rounded-lg border border-line-soft bg-surface-1/40 p-4"
    >
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-baseline gap-2">
          <h2 className="text-eyebrow text-text-secondary">Cockpit</h2>
          <span className="num text-xs text-text-muted">
            · {totalOpen} open deal{totalOpen === 1 ? "" : "s"}
          </span>
        </div>
        <div className="flex flex-wrap items-center gap-1.5 text-[11px]">
          <SummaryPill label="Blocked" count={data.summary.blocked} tone="bad" />
          <SummaryPill label="At risk" count={data.summary.at_risk} tone="warn" />
          <SummaryPill label="Stale" count={data.summary.stale} tone="muted" />
          <SummaryPill
            label="Healthy"
            count={data.summary.healthy}
            tone="good"
          />
        </div>
      </header>
      <div className="flex flex-col gap-3">
        {groups.map(([urgency, deals]) => {
          if (deals.length === 0) return null;
          if (urgency === "healthy" && !showHealthy) {
            return (
              <CollapsedHealthy
                key="healthy"
                count={deals.length}
                onExpand={() => setShowHealthy(true)}
              />
            );
          }
          const meta = GROUP_META[urgency];
          return (
            <div key={urgency} className="flex flex-col gap-1.5">
              <div className="flex items-center gap-2">
                <span
                  aria-hidden="true"
                  className={`inline-block h-1.5 w-1.5 rounded-full ${meta.dotClass}`}
                />
                <h3 className={`text-eyebrow ${meta.headerTone}`}>
                  {meta.title}
                </h3>
                <span className="num text-[11px] text-text-muted">
                  · {deals.length}
                </span>
              </div>
              <ul className="flex flex-col gap-1.5">
                {deals.map((d) => (
                  <DealCockpitRow key={d.dealId} deal={d} />
                ))}
              </ul>
            </div>
          );
        })}
      </div>
    </section>
  );
}

function SummaryPill({
  label,
  count,
  tone,
}: {
  label: string;
  count: number;
  tone: "bad" | "warn" | "muted" | "good";
}) {
  const classes =
    tone === "bad"
      ? "border-bad/40 bg-bad/10 text-bad"
      : tone === "warn"
        ? "border-warn/40 bg-warn/10 text-warn"
        : tone === "good"
          ? "border-emerald-400/40 bg-emerald-400/10 text-emerald-300"
          : "border-line-soft bg-surface-2/60 text-text-muted";
  return (
    <span
      className={`num rounded-full border px-2 py-0.5 ${classes}`}
      title={`${count} ${label.toLowerCase()}`}
    >
      {count} {label}
    </span>
  );
}

function DealCockpitRow({ deal }: { deal: PulseDeal }) {
  const primary =
    deal.blockers[0]?.detail ?? deal.attention[0]?.detail ?? null;
  const toneBorder =
    deal.urgency === "blocked"
      ? "border-bad/30"
      : deal.urgency === "at_risk"
        ? "border-warn/30"
        : "border-line-soft";
  return (
    <li>
      <Link
        href={`/app/deals/${deal.dealId}`}
        className={`hover-lift block rounded-md border ${toneBorder} bg-surface-2/40 px-3 py-2.5 transition-colors hover:bg-surface-2/60`}
      >
        <div className="flex flex-wrap items-baseline gap-2">
          <span className="num-mono text-sm font-semibold text-text-primary">
            {deal.dealRef}
          </span>
          <span className="rounded bg-surface-2 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wider2 text-text-muted">
            {deal.status.replace(/_/g, " ")}
          </span>
          <span className="text-xs text-text-secondary">
            {deal.product.replace(/_/g, " ")}
          </span>
          <span className="text-xs text-text-muted">·</span>
          <span className="num text-xs text-text-secondary">
            {formatVolume(deal.volumeUsg, deal.volumeUnit)}
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
            {deal.ageDays === 0
              ? "updated today"
              : `${deal.ageDays}d ago`}
          </span>
        </div>
        {primary ? (
          <div className="mt-1 text-xs text-text-secondary/90">{primary}</div>
        ) : null}
        {deal.nextAction ? (
          <div className="mt-0.5 text-xs">
            <span className="text-eyebrow text-accent-strong mr-1.5">
              Next
            </span>
            <span className="text-text-primary/90">{deal.nextAction}</span>
          </div>
        ) : null}
      </Link>
    </li>
  );
}

function CollapsedHealthy({
  count,
  onExpand,
}: {
  count: number;
  onExpand: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onExpand}
      className="flex items-center gap-2 rounded-md border border-dashed border-line-soft px-3 py-2 text-left text-xs text-text-muted transition-colors hover:border-line hover:text-text-secondary"
    >
      <span
        aria-hidden="true"
        className="inline-block h-1.5 w-1.5 rounded-full bg-emerald-400/60"
      />
      <span>
        <span className="num font-medium text-emerald-300/90">{count}</span>{" "}
        healthy deal{count === 1 ? "" : "s"} — show
      </span>
    </button>
  );
}

function CockpitSkeleton() {
  return (
    <section
      className="flex flex-col gap-3 rounded-lg border border-line-soft bg-surface-1/40 p-4"
      aria-busy="true"
    >
      <div className="h-3 w-28 animate-pulse rounded bg-white/5" />
      <div className="h-10 w-full animate-pulse rounded bg-white/[0.02]" />
      <div className="h-10 w-full animate-pulse rounded bg-white/[0.02]" />
    </section>
  );
}

function formatVolume(volumeUsg: number, unit: string): string {
  const u = unit === "usg" ? "USG" : unit.toUpperCase();
  if (volumeUsg >= 1_000_000) {
    return `${(volumeUsg / 1_000_000).toFixed(1)}M ${u}`;
  }
  if (volumeUsg >= 1_000) {
    return `${(volumeUsg / 1_000).toFixed(0)}k ${u}`;
  }
  return `${volumeUsg} ${u}`;
}
