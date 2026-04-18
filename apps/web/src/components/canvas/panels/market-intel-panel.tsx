"use client";

import type { ManifestPanel } from "@vex/ui";

type MarketIntelPanelProps = Extract<ManifestPanel, { type: "market_intel" }>;

const PRODUCT_LABELS: Record<string, string> = {
  crude: "Crude",
  diesel: "Diesel",
  gasoline: "Gasoline",
  jet: "Jet",
  natural_gas: "Natural gas",
};

const BENCHMARK_LABELS: Record<string, string> = {
  WTI: "WTI",
  BRENT: "Brent",
  US_RETAIL: "US retail",
  NY_HARBOR_ULSD: "NY ULSD",
  HENRY_HUB: "Henry Hub",
};

export function MarketIntelPanel({
  title,
  rates,
  alerts,
  baselineLabel,
}: MarketIntelPanelProps) {
  const heading = title ?? "Market intel";
  const baseline = baselineLabel ?? "30d";

  return (
    <section
      data-panel="market_intel"
      className="rounded-lg border border-line bg-muted/40 p-4 space-y-4"
    >
      <header className="flex items-baseline justify-between gap-3">
        <h3 className="text-sm font-semibold uppercase tracking-wider text-white/80">
          {heading}
        </h3>
        <span className="text-xs text-white/40">vs {baseline} baseline</span>
      </header>

      <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
        {rates.map((r) => (
          <article
            key={`${r.product}:${r.benchmark}`}
            className="rounded-md border border-line/60 bg-canvas/40 p-3"
          >
            <div className="flex items-baseline justify-between gap-2 text-xs text-white/50">
              <span className="uppercase tracking-wider">
                {PRODUCT_LABELS[r.product] ?? r.product} · {BENCHMARK_LABELS[r.benchmark] ?? r.benchmark}
              </span>
              <span>{r.rateDate}</span>
            </div>
            <div className="mt-1 flex items-baseline gap-2 text-2xl font-semibold text-white">
              <span>${r.pricePerUsg.toFixed(3)}</span>
              <span className="text-sm font-normal text-white/50">/USG</span>
            </div>
            <dl className="mt-1 flex flex-wrap gap-x-4 gap-y-0.5 text-xs text-white/50">
              <div>
                <dt className="inline text-white/40">bbl </dt>
                <dd className="inline text-white/70">${r.pricePerBbl.toFixed(2)}</dd>
              </div>
              <div>
                <dt className="inline text-white/40">mt </dt>
                <dd className="inline text-white/70">${r.pricePerMt.toFixed(0)}</dd>
              </div>
            </dl>
            {typeof r.changePct === "number" && (
              <div
                className={`mt-2 inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-xs ${
                  r.changePct >= 0 ? "bg-good/20 text-good" : "bg-bad/20 text-bad"
                }`}
              >
                <span>{r.changePct >= 0 ? "▲" : "▼"}</span>
                <span>{Math.abs(r.changePct).toFixed(1)}%</span>
              </div>
            )}
            <div className="mt-1 text-[10px] uppercase tracking-wider text-white/30">
              src: {r.source}
            </div>
          </article>
        ))}
      </div>

      {alerts.length > 0 && (
        <div className="border-t border-line/60 pt-3">
          <h4 className="mb-2 text-xs uppercase tracking-wider text-white/50">
            Recent crossings
          </h4>
          <ul className="space-y-1.5">
            {alerts.map((a, i) => (
              <li
                key={`${a.product}:${a.benchmark}:${i}`}
                className="flex items-baseline justify-between gap-3 rounded-md bg-canvas/30 px-3 py-1.5 text-sm"
              >
                <span className="flex items-baseline gap-2 text-white/90">
                  <span
                    className={
                      a.direction === "up"
                        ? "text-good"
                        : "text-bad"
                    }
                  >
                    {a.direction === "up" ? "▲" : "▼"} {Math.abs(a.changePct).toFixed(1)}%
                  </span>
                  <span className="text-white/70">
                    {PRODUCT_LABELS[a.product] ?? a.product} · {BENCHMARK_LABELS[a.benchmark] ?? a.benchmark}
                  </span>
                </span>
                <span className="flex items-baseline gap-3 text-xs text-white/40">
                  <span>
                    ${a.currentPriceUsg.toFixed(3)} <span className="text-white/30">/USG</span>
                  </span>
                  <time dateTime={a.occurredAt}>
                    {new Date(a.occurredAt).toLocaleString()}
                  </time>
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}
