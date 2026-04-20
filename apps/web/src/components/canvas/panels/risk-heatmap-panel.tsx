"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import type { ManifestPanel } from "@vex/ui";

type Props = Extract<ManifestPanel, { type: "risk_heatmap" }>;
type Row = Props["rows"][number];
type Tier = Row["tier"];
type Ofac = Row["ofacStatus"];

const TIERS: Tier[] = ["tier_1", "tier_2", "tier_3", "watch", "declined"];
const OFAC: Ofac[] = [
  "cleared",
  "in_progress",
  "not_started",
  "flagged",
  "rejected",
];

const TIER_LABEL: Record<Tier, string> = {
  tier_1: "Tier 1",
  tier_2: "Tier 2",
  tier_3: "Tier 3",
  watch: "Watch",
  declined: "Declined",
};

const OFAC_LABEL: Record<Ofac, string> = {
  cleared: "Cleared",
  in_progress: "In progress",
  not_started: "Not started",
  flagged: "Flagged",
  rejected: "Rejected",
};

/** Coarse risk score so cells get an inherent red/green bias before exposure weighting. */
function cellRiskBias(tier: Tier, ofac: Ofac): "safe" | "neutral" | "warn" | "danger" {
  if (ofac === "rejected" || ofac === "flagged" || tier === "declined") return "danger";
  if (tier === "watch" || ofac === "not_started") return "warn";
  if (tier === "tier_1" && ofac === "cleared") return "safe";
  if (tier === "tier_2" && ofac === "cleared") return "safe";
  return "neutral";
}

function formatUsd(n: number): string {
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `$${(n / 1_000).toFixed(0)}k`;
  return `$${n.toFixed(0)}`;
}

function biasBase(bias: ReturnType<typeof cellRiskBias>): string {
  switch (bias) {
    case "safe":
      return "bg-good/10 border-good/30";
    case "warn":
      return "bg-warn/10 border-warn/30";
    case "danger":
      return "bg-bad/10 border-bad/30";
    case "neutral":
      return "bg-white/5 border-line";
  }
}

function biasAccent(bias: ReturnType<typeof cellRiskBias>): string {
  switch (bias) {
    case "safe":
      return "text-good";
    case "warn":
      return "text-warn";
    case "danger":
      return "text-bad";
    case "neutral":
      return "text-white/70";
  }
}

export function RiskHeatmapPanel({ title, rows }: Props) {
  // Bucket rows by (tier, ofac) → { orgs, count, exposure }.
  const buckets = useMemo(() => {
    const m = new Map<string, { rows: Row[]; exposure: number }>();
    for (const r of rows) {
      const key = `${r.tier}|${r.ofacStatus}`;
      const b = m.get(key) ?? { rows: [], exposure: 0 };
      b.rows.push(r);
      b.exposure += r.totalExposureUsd;
      m.set(key, b);
    }
    return m;
  }, [rows]);

  const maxExposure = useMemo(() => {
    let max = 0;
    for (const b of buckets.values()) if (b.exposure > max) max = b.exposure;
    return max;
  }, [buckets]);

  const [active, setActive] = useState<{ tier: Tier; ofac: Ofac } | null>(null);
  const activeKey = active ? `${active.tier}|${active.ofac}` : null;
  const activeBucket = activeKey ? buckets.get(activeKey) : null;

  const totalExposure = rows.reduce((sum, r) => sum + r.totalExposureUsd, 0);
  const totalDeals = rows.reduce((sum, r) => sum + r.dealCount, 0);

  return (
    <section
      data-panel="risk_heatmap"
      className="overflow-hidden rounded-lg border border-line bg-muted/40"
    >
      <header className="flex items-baseline justify-between border-b border-line px-4 py-3">
        <h3 className="text-sm font-semibold text-white">{title}</h3>
        <span className="text-xs text-white/40">
          {rows.length} orgs · {totalDeals} deals · {formatUsd(totalExposure)} exposure
        </span>
      </header>

      <div className="overflow-x-auto p-4">
        <div className="inline-grid min-w-max grid-cols-[120px_repeat(5,minmax(120px,1fr))] gap-1 text-xs">
          {/* Header row */}
          <div />
          {OFAC.map((o) => (
            <div
              key={`h-${o}`}
              className="px-2 py-1 text-center text-[11px] uppercase tracking-wider text-white/40"
            >
              {OFAC_LABEL[o]}
            </div>
          ))}
          {/* Data rows */}
          {TIERS.map((t) => (
            <div key={`row-${t}`} className="contents">
              <div className="flex items-center justify-end pr-2 text-[11px] uppercase tracking-wider text-white/40">
                {TIER_LABEL[t]}
              </div>
              {OFAC.map((o) => {
                const bucket = buckets.get(`${t}|${o}`);
                const bias = cellRiskBias(t, o);
                const base = biasBase(bias);
                const accent = biasAccent(bias);
                const intensity =
                  maxExposure > 0 && bucket
                    ? Math.min(1, bucket.exposure / maxExposure)
                    : 0;
                const isActive = active?.tier === t && active?.ofac === o;
                return (
                  <button
                    key={`c-${t}-${o}`}
                    type="button"
                    data-testid={`risk-cell-${t}-${o}`}
                    onClick={() => {
                      if (!bucket) return;
                      setActive(isActive ? null : { tier: t, ofac: o });
                    }}
                    disabled={!bucket}
                    className={`flex min-h-[72px] flex-col items-center justify-center rounded-md border p-2 text-center transition ${base} ${
                      bucket ? "hover:scale-[1.02]" : "opacity-30"
                    } ${isActive ? "ring-2 ring-accent" : ""}`}
                    style={
                      bucket
                        ? { backgroundColor: `rgba(234, 179, 8, ${0.06 + intensity * 0.18})` }
                        : undefined
                    }
                  >
                    {bucket ? (
                      <>
                        <span className={`text-base font-semibold ${accent}`}>
                          {bucket.rows.length}
                        </span>
                        <span className="text-[11px] text-white/60">
                          {formatUsd(bucket.exposure)}
                        </span>
                      </>
                    ) : (
                      <span className="text-[11px] text-white/20">—</span>
                    )}
                  </button>
                );
              })}
            </div>
          ))}
        </div>
      </div>

      {activeBucket && active ? (
        <div className="border-t border-line bg-canvas/40 px-4 py-3">
          <div className="mb-2 flex items-baseline justify-between">
            <h4 className="text-sm font-semibold text-white">
              {TIER_LABEL[active.tier]} · {OFAC_LABEL[active.ofac]}
            </h4>
            <button
              type="button"
              onClick={() => setActive(null)}
              className="text-xs text-white/40 hover:text-white"
            >
              close
            </button>
          </div>
          <ul className="space-y-1 text-sm">
            {activeBucket.rows
              .slice()
              .sort((a, b) => b.totalExposureUsd - a.totalExposureUsd)
              .map((r) => (
                <li
                  key={r.organizationId}
                  className="flex items-center justify-between gap-3 rounded border border-line/50 bg-muted/40 px-3 py-1.5"
                >
                  <Link
                    href={`/app/companies/${encodeURIComponent(r.organizationId)}`}
                    className="truncate text-white/90 hover:text-accent"
                  >
                    {r.organizationName}
                  </Link>
                  <span className="flex flex-shrink-0 gap-3 text-xs text-white/60">
                    <span>{r.dealCount} deal{r.dealCount === 1 ? "" : "s"}</span>
                    <span className="font-mono">{formatUsd(r.totalExposureUsd)}</span>
                    {typeof r.lastPaymentDaysAgo === "number" ? (
                      <span className="text-white/40">paid {r.lastPaymentDaysAgo}d ago</span>
                    ) : null}
                  </span>
                </li>
              ))}
          </ul>
        </div>
      ) : null}
    </section>
  );
}
