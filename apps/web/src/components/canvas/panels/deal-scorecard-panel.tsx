"use client";

import type { ManifestPanel } from "@vex/ui";

type DealScorecardProps = Extract<ManifestPanel, { type: "deal_scorecard" }>;

const TONE_CLASS: Record<
  NonNullable<DealScorecardProps["metrics"][number]["tone"]>,
  string
> = {
  good: "border-good/40 text-good",
  warn: "border-warn/40 text-warn",
  bad: "border-bad/40 text-bad",
  neutral: "border-line text-white",
};

/**
 * Deal scorecard — a single-deal view for "what's the economics on
 * VTC-2026-002?" style questions. Headline metric strip on top, deal
 * meta (buyer, lane, volume, status) on the side, recommendation +
 * compliance flags on the bottom. Mirrors the scenario calculator's
 * output shape so the prose answer and the panel always agree.
 */
export function DealScorecardPanel({
  dealRef,
  product,
  status,
  buyer,
  lane,
  volumeUsg,
  metrics,
  recommendation,
  flags,
}: DealScorecardProps) {
  return (
    <section
      data-panel="deal_scorecard"
      className="overflow-hidden rounded-lg border border-line bg-muted/30"
    >
      <header className="flex items-center justify-between border-b border-line px-4 py-2.5">
        <div className="flex items-center gap-2">
          <span className="inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-accent" />
          <span className="font-mono text-sm font-semibold text-white">
            {dealRef}
          </span>
          {product && (
            <span className="rounded border border-line px-1.5 py-0.5 font-mono text-[10px] uppercase text-white/70">
              {product}
            </span>
          )}
        </div>
        {status && <StatusChip status={status} />}
      </header>

      <div className="grid grid-cols-1 gap-4 p-4 lg:grid-cols-[1fr_180px]">
        <div>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
            {metrics.map((m, i) => (
              <Metric key={i} label={m.label} value={m.value} tone={m.tone} />
            ))}
          </div>

          {(recommendation || (flags && flags.length > 0)) && (
            <div className="mt-4 space-y-2 border-t border-line pt-3">
              {recommendation && (
                <div className="flex items-start gap-2 text-xs">
                  <span className="mt-0.5 rounded bg-accent/20 px-1.5 py-0.5 font-mono text-[10px] uppercase text-accent">
                    Rec
                  </span>
                  <span className="text-white/80">{recommendation}</span>
                </div>
              )}
              {flags && flags.length > 0 && (
                <div className="flex flex-wrap items-center gap-1.5 text-xs">
                  <span className="rounded bg-warn/20 px-1.5 py-0.5 font-mono text-[10px] uppercase text-warn">
                    Flags
                  </span>
                  {flags.map((f, i) => (
                    <span
                      key={i}
                      className="rounded border border-warn/30 bg-warn/5 px-1.5 py-0.5 text-[11px] text-warn"
                    >
                      {f}
                    </span>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>

        {(buyer || lane || volumeUsg) && (
          <aside className="rounded-md border border-line/60 bg-canvas/40 p-3">
            <div className="mb-2 text-[10px] uppercase tracking-wider text-white/50">
              Deal
            </div>
            <dl className="space-y-1.5 text-[12px]">
              {buyer && (
                <Row label="Buyer" value={buyer} />
              )}
              {lane && <Row label="Lane" value={lane} mono />}
              {volumeUsg && <Row label="Volume" value={volumeUsg} />}
            </dl>
          </aside>
        )}
      </div>
    </section>
  );
}

function Metric({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone?: DealScorecardProps["metrics"][number]["tone"];
}) {
  const cls = TONE_CLASS[tone ?? "neutral"];
  return (
    <div className={`rounded-md border bg-canvas/40 p-3 ${cls}`}>
      <div className="text-[10px] uppercase tracking-wider text-white/40">
        {label}
      </div>
      <div className="mt-1 font-mono text-lg font-semibold leading-tight">
        {value}
      </div>
    </div>
  );
}

function Row({
  label,
  value,
  mono,
}: {
  label: string;
  value: string;
  mono?: boolean;
}) {
  return (
    <div className="flex items-baseline justify-between gap-2">
      <dt className="text-white/50">{label}</dt>
      <dd className={mono ? "font-mono text-white" : "text-white"}>{value}</dd>
    </div>
  );
}

function StatusChip({ status }: { status: string }) {
  const s = status.toLowerCase();
  const cls = s.includes("approv")
    ? "border-good/50 bg-good/10 text-good"
    : s.includes("reject") || s.includes("hold")
      ? "border-bad/50 bg-bad/10 text-bad"
      : s.includes("negot") || s.includes("review")
        ? "border-warn/50 bg-warn/10 text-warn"
        : "border-line bg-canvas/40 text-white/70";
  return (
    <span
      className={`rounded border px-2 py-0.5 font-mono text-[10px] uppercase ${cls}`}
    >
      {status}
    </span>
  );
}
