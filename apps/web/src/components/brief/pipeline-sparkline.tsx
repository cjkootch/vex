"use client";

import { useEffect, useState } from "react";

/**
 * 14-day deal-creation sparkline that sits above the pipeline rows.
 * Pure SVG — no chart library dependency. Fetches its own data so
 * the home page can continue rendering if this fails.
 */
interface TrendDay {
  date: string;
  count: number;
}

export function PipelineSparkline(): React.ReactElement | null {
  const [days, setDays] = useState<TrendDay[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/deals/pipeline-trend", { cache: "no-store" })
      .then((res) => (res.ok ? res.json() : Promise.reject(res.status)))
      .then((body: { days?: TrendDay[] }) => {
        if (!cancelled && Array.isArray(body.days)) setDays(body.days);
      })
      .catch(() => {
        /* silent — sparkline is decorative */
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (!days || days.length === 0) return null;
  const total = days.reduce((a, d) => a + d.count, 0);
  const max = Math.max(1, ...days.map((d) => d.count));
  const width = 280;
  const height = 36;
  const step = width / (days.length - 1);
  const points = days
    .map((d, i) => {
      const x = i * step;
      const y = height - (d.count / max) * height;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");

  const last = days[days.length - 1]?.count ?? 0;
  const prev = days[days.length - 2]?.count ?? 0;
  const delta = last - prev;

  return (
    <div className="mb-3 flex items-center gap-3 rounded-md border border-line bg-muted/20 px-3 py-2">
      <div className="flex flex-col">
        <span className="text-xs text-white/50">14-day trend</span>
        <span className="text-sm text-white/80">
          {total} new deal{total === 1 ? "" : "s"}
        </span>
      </div>
      <svg
        width={width}
        height={height}
        viewBox={`0 0 ${width} ${height}`}
        className="text-accent"
        role="img"
        aria-label={`${total} deals over the last 14 days`}
      >
        <polyline
          points={points}
          fill="none"
          stroke="currentColor"
          strokeWidth={1.5}
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        {days.map((d, i) => {
          const x = i * step;
          const y = height - (d.count / max) * height;
          return (
            <circle key={d.date} cx={x} cy={y} r={1.5} fill="currentColor" />
          );
        })}
      </svg>
      <DeltaPill delta={delta} />
    </div>
  );
}

function DeltaPill({ delta }: { delta: number }): React.ReactElement {
  if (delta === 0) {
    return <span className="text-xs text-white/40">flat</span>;
  }
  const sign = delta > 0 ? "+" : "";
  const cls =
    delta > 0 ? "bg-good/20 text-good" : "bg-muted/60 text-white/60";
  return (
    <span className={`rounded px-1.5 py-0.5 text-xs ${cls}`}>
      {sign}
      {delta} d/d
    </span>
  );
}
