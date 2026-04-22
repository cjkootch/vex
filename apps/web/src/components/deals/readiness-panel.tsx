"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { formatDistanceToNow } from "date-fns";
import { buildAskVexHref } from "@/lib/ask-vex";

/**
 * Readiness matrix — per-deal operational checklist. Eight checks
 * join everything that can stop a cargo from shipping (KYC, OFAC,
 * counterparty tier, freight freshness, vessel, payment terms,
 * docs, next milestone owner) and reduce each to a traffic-light
 * state. The operator sees at a glance what's blocking the deal
 * without clicking through seven tabs and running five queries.
 *
 * Each row links directly to Ask Vex with a scoped, prompt-ready
 * question when the operator wants Vex to handle the unblock.
 */

export type ReadinessState =
  | "complete"
  | "stale"
  | "incomplete"
  | "missing"
  | "blocked";

interface ReadinessCheck {
  id: string;
  label: string;
  state: ReadinessState;
  detail: string;
  lastVerifiedAt: string | null;
  ask: string;
  deepLink: string | null;
}

interface ReadinessResponse {
  dealId: string;
  dealRef: string;
  status: string;
  summary: {
    total: number;
    complete: number;
    blocked: number;
    attention: number;
  };
  checks: ReadinessCheck[];
}

const STATE_DOT: Record<ReadinessState, string> = {
  complete: "bg-emerald-400",
  stale: "bg-amber-400",
  incomplete: "bg-amber-400",
  missing: "bg-white/40",
  blocked: "bg-red-500",
};

const STATE_BORDER: Record<ReadinessState, string> = {
  complete: "border-emerald-400/30",
  stale: "border-amber-400/40",
  incomplete: "border-amber-400/40",
  missing: "border-line",
  blocked: "border-red-500/50",
};

const STATE_BG: Record<ReadinessState, string> = {
  complete: "bg-emerald-400/5",
  stale: "bg-amber-400/5",
  incomplete: "bg-amber-400/5",
  missing: "bg-muted/20",
  blocked: "bg-red-500/5",
};

const STATE_PILL: Record<ReadinessState, string> = {
  complete: "bg-emerald-400/15 text-emerald-300",
  stale: "bg-amber-400/15 text-amber-200",
  incomplete: "bg-amber-400/15 text-amber-200",
  missing: "bg-muted/60 text-white/50",
  blocked: "bg-red-500/15 text-red-300",
};

const STATE_LABEL: Record<ReadinessState, string> = {
  complete: "OK",
  stale: "Stale",
  incomplete: "Partial",
  missing: "Missing",
  blocked: "Blocked",
};

/**
 * Order checks so blockers float to the top, then anything that
 * needs attention (stale / incomplete / missing), then the
 * complete ones. Same priority rule as the summary counts —
 * operators scan top-down for what to act on.
 */
const STATE_WEIGHT: Record<ReadinessState, number> = {
  blocked: 0,
  missing: 1,
  incomplete: 2,
  stale: 3,
  complete: 4,
};

interface Props {
  dealId: string;
  dealRef: string;
}

export function ReadinessPanel({ dealId, dealRef }: Props): React.ReactElement {
  const [data, setData] = useState<ReadinessResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setData(null);
    setError(null);
    fetch(`/api/deals/${dealId}/readiness`)
      .then(async (res) => {
        if (!res.ok) throw new Error(`${res.status}`);
        return res.json();
      })
      .then((body: ReadinessResponse) => {
        if (!cancelled) setData(body);
      })
      .catch((err: Error) => {
        if (!cancelled) setError(err.message);
      });
    return () => {
      cancelled = true;
    };
  }, [dealId]);

  if (error) {
    return (
      <div className="rounded-md border border-bad/40 bg-bad/10 px-3 py-2 text-sm text-bad">
        Couldn&apos;t load readiness: {error}
      </div>
    );
  }
  if (!data) {
    return <ReadinessSkeleton />;
  }

  const sorted = [...data.checks].sort(
    (a, b) => STATE_WEIGHT[a.state] - STATE_WEIGHT[b.state],
  );

  return (
    <section className="flex flex-col gap-4">
      <SummaryHeader dealRef={dealRef} summary={data.summary} />
      <ul className="flex flex-col gap-2">
        {sorted.map((check) => (
          <CheckRow key={check.id} check={check} dealId={dealId} dealRef={dealRef} />
        ))}
      </ul>
    </section>
  );
}

function SummaryHeader({
  dealRef,
  summary,
}: {
  dealRef: string;
  summary: ReadinessResponse["summary"];
}) {
  const label =
    summary.blocked > 0
      ? `${summary.blocked} blocker${summary.blocked === 1 ? "" : "s"}`
      : summary.attention > 0
        ? `${summary.attention} need${summary.attention === 1 ? "s" : ""} attention`
        : "All checks green";
  const tone =
    summary.blocked > 0
      ? "text-red-300"
      : summary.attention > 0
        ? "text-amber-300"
        : "text-emerald-300";
  return (
    <header className="flex flex-wrap items-baseline justify-between gap-3 rounded-lg border border-line bg-muted/20 px-4 py-3">
      <div>
        <div className="text-[10px] uppercase tracking-wider text-white/40">
          Readiness · Deal {dealRef}
        </div>
        <div className={`mt-0.5 text-lg font-semibold ${tone}`}>{label}</div>
      </div>
      <div className="flex items-center gap-2 text-xs text-white/60">
        <SummaryPill
          label="Blocked"
          count={summary.blocked}
          tone={summary.blocked > 0 ? "bad" : "neutral"}
        />
        <SummaryPill
          label="Attention"
          count={summary.attention}
          tone={summary.attention > 0 ? "warn" : "neutral"}
        />
        <SummaryPill label="OK" count={summary.complete} tone="good" />
      </div>
    </header>
  );
}

function SummaryPill({
  label,
  count,
  tone,
}: {
  label: string;
  count: number;
  tone: "bad" | "warn" | "good" | "neutral";
}) {
  const classes =
    tone === "bad"
      ? "border-red-500/40 bg-red-500/10 text-red-300"
      : tone === "warn"
        ? "border-amber-400/40 bg-amber-400/10 text-amber-200"
        : tone === "good"
          ? "border-emerald-400/40 bg-emerald-400/10 text-emerald-300"
          : "border-line bg-muted/30 text-white/60";
  return (
    <span className={`rounded-full border px-2 py-0.5 text-[11px] ${classes}`}>
      {count} {label}
    </span>
  );
}

function CheckRow({
  check,
  dealId,
  dealRef,
}: {
  check: ReadinessCheck;
  dealId: string;
  dealRef: string;
}) {
  const askHref = buildAskVexHref({
    type: "deal",
    id: dealId,
    label: dealRef,
    ask: check.ask,
  });
  return (
    <li
      className={`flex flex-col gap-2 rounded-lg border ${STATE_BORDER[check.state]} ${STATE_BG[check.state]} px-4 py-3 sm:flex-row sm:items-center sm:gap-4`}
    >
      <div className="flex flex-1 items-start gap-3">
        <span
          aria-hidden="true"
          className={`mt-1 h-2 w-2 flex-shrink-0 rounded-full ${STATE_DOT[check.state]}`}
        />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium text-white">
              {check.label}
            </span>
            <span
              className={`rounded px-1.5 py-0.5 text-[10px] uppercase tracking-wider ${STATE_PILL[check.state]}`}
            >
              {STATE_LABEL[check.state]}
            </span>
          </div>
          <div className="mt-0.5 text-xs text-white/60">{check.detail}</div>
          {check.lastVerifiedAt ? (
            <div className="mt-0.5 text-[10px] text-white/40">
              Last verified{" "}
              {formatDistanceToNow(new Date(check.lastVerifiedAt), {
                addSuffix: true,
              })}
            </div>
          ) : null}
        </div>
      </div>
      <div className="flex items-center gap-2 sm:justify-end">
        {check.deepLink ? (
          <Link
            href={check.deepLink}
            className="rounded-md border border-line bg-muted/40 px-3 py-1 text-xs text-white/80 hover:border-white/30 hover:text-white"
          >
            View
          </Link>
        ) : null}
        <Link
          href={askHref}
          className="rounded-md bg-accent px-3 py-1 text-xs font-medium text-bg hover:bg-accent/85"
        >
          Ask Vex
        </Link>
      </div>
    </li>
  );
}

function ReadinessSkeleton() {
  return (
    <div className="flex flex-col gap-2" aria-busy="true">
      <div className="h-20 w-full rounded-lg bg-white/5" />
      {[0, 1, 2, 3, 4].map((i) => (
        <div key={i} className="h-14 w-full rounded-lg bg-white/5" />
      ))}
    </div>
  );
}
