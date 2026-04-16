"use client";

import type { ManifestPanel } from "@vex/ui";

type KpiRailProps = Extract<ManifestPanel, { type: "kpi_rail" }>;

const TREND_BADGE: Record<NonNullable<KpiRailProps["metrics"][number]["trend"]>, string> = {
  up: "bg-good/20 text-good",
  down: "bg-bad/20 text-bad",
  flat: "bg-white/10 text-white/70",
};

const TREND_GLYPH: Record<NonNullable<KpiRailProps["metrics"][number]["trend"]>, string> = {
  up: "▲",
  down: "▼",
  flat: "—",
};

export function KpiRailPanel({ metrics }: KpiRailProps) {
  return (
    <section
      data-panel="kpi_rail"
      className="flex flex-wrap gap-3 rounded-lg border border-line bg-muted/40 p-4"
    >
      {metrics.map((m, i) => (
        <div
          key={i}
          className="min-w-[140px] flex-1 rounded-md border border-line/60 bg-canvas/40 p-3"
        >
          <div className="text-xs uppercase tracking-wider text-white/40">{m.label}</div>
          <div className="mt-1 flex items-baseline gap-1 text-2xl font-semibold text-white">
            {m.value}
            {m.unit && <span className="text-sm font-normal text-white/60">{m.unit}</span>}
          </div>
          {m.delta && (
            <div
              className={`mt-1 inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-xs ${
                TREND_BADGE[m.trend ?? "flat"]
              }`}
            >
              <span>{TREND_GLYPH[m.trend ?? "flat"]}</span>
              <span>{m.delta}</span>
            </div>
          )}
        </div>
      ))}
    </section>
  );
}
