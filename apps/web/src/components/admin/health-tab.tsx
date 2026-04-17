"use client";

import { useEffect, useState } from "react";
import { fetchWithRetry } from "@/lib/fetch-with-retry";

interface AgentStats {
  agentName: string;
  runs: number;
  failures: number;
  totalCostUsd: number;
  avgDurationSeconds: number | null;
}

interface HealthMetrics {
  window: { from: string; to: string };
  totalRuns: number;
  completed: number;
  failed: number;
  failureRate: number;
  avgDurationSeconds: number | null;
  totalCostUsd: number;
  byAgent: AgentStats[];
}

/**
 * Seven-day agent-run roll-up. Polls /api/admin/health once on mount;
 * refresh is manual to keep load low — the numbers here change on the
 * order of minutes, not seconds.
 */
export function HealthTab() {
  const [metrics, setMetrics] = useState<HealthMetrics | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshIdx, setRefreshIdx] = useState(0);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetchWithRetry("/api/admin/health", {
          credentials: "include",
          cache: "no-store",
          onWaking: () => {
            if (!cancelled) setError("API is waking up…");
          },
        });
        if (res.status === 502 || res.status === 503) {
          throw new Error("API is still waking up. Try again in a moment.");
        }
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const body = (await res.json()) as HealthMetrics;
        if (!cancelled) {
          setMetrics(body);
          setError(null);
        }
      } catch (err) {
        if (!cancelled) setError((err as Error).message);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [refreshIdx]);

  return (
    <section className="space-y-6">
      <header className="flex items-center justify-between">
        <div>
          <h2 className="text-sm font-semibold uppercase tracking-wider text-white/70">
            Last 7 days
          </h2>
          {metrics ? (
            <p className="mt-1 text-xs text-white/50">
              {new Date(metrics.window.from).toLocaleDateString()} &rarr;{" "}
              {new Date(metrics.window.to).toLocaleDateString()}
            </p>
          ) : null}
        </div>
        <button
          type="button"
          onClick={() => setRefreshIdx((i) => i + 1)}
          className="rounded-md border border-line bg-muted/40 px-3 py-1 text-xs text-white/70 transition hover:border-white/30 hover:text-white"
        >
          Refresh
        </button>
      </header>

      {error ? (
        <p className="text-sm text-red-400">Couldn&rsquo;t load metrics: {error}</p>
      ) : null}

      {!metrics && !error ? (
        <p className="text-sm text-white/50">Loading metrics…</p>
      ) : null}

      {metrics ? (
        <>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <Stat label="Runs" value={metrics.totalRuns.toString()} />
            <Stat
              label="Failure rate"
              value={`${(metrics.failureRate * 100).toFixed(1)}%`}
              tone={metrics.failureRate > 0.1 ? "warning" : "neutral"}
            />
            <Stat
              label="Avg duration"
              value={
                metrics.avgDurationSeconds !== null
                  ? `${metrics.avgDurationSeconds.toFixed(1)}s`
                  : "—"
              }
            />
            <Stat
              label="Total cost"
              value={`$${metrics.totalCostUsd.toFixed(2)}`}
            />
          </div>

          <div>
            <h3 className="mb-2 text-xs font-semibold uppercase tracking-wider text-white/50">
              By agent
            </h3>
            <table
              className="w-full border-separate border-spacing-0 overflow-hidden rounded-lg border border-line bg-muted/20 text-sm"
              data-table="health-by-agent"
            >
              <thead>
                <tr className="text-left text-xs uppercase tracking-wider text-white/50">
                  <th className="px-4 py-2 font-medium">Agent</th>
                  <th className="px-4 py-2 font-medium">Runs</th>
                  <th className="px-4 py-2 font-medium">Failures</th>
                  <th className="px-4 py-2 font-medium">Avg</th>
                  <th className="px-4 py-2 font-medium text-right">Cost</th>
                </tr>
              </thead>
              <tbody>
                {metrics.byAgent.map((a) => (
                  <tr
                    key={a.agentName}
                    className="border-t border-line/60 text-white/80"
                  >
                    <td className="px-4 py-2 font-mono text-xs">
                      {a.agentName}
                    </td>
                    <td className="px-4 py-2">{a.runs}</td>
                    <td className="px-4 py-2">
                      <span
                        className={a.failures > 0 ? "text-red-300" : "text-white/50"}
                      >
                        {a.failures}
                      </span>
                    </td>
                    <td className="px-4 py-2 text-white/60">
                      {a.avgDurationSeconds !== null
                        ? `${a.avgDurationSeconds.toFixed(1)}s`
                        : "—"}
                    </td>
                    <td className="px-4 py-2 text-right">
                      ${a.totalCostUsd.toFixed(2)}
                    </td>
                  </tr>
                ))}
                {metrics.byAgent.length === 0 ? (
                  <tr>
                    <td
                      colSpan={5}
                      className="px-4 py-6 text-center text-xs text-white/40"
                    >
                      No agent runs in the window.
                    </td>
                  </tr>
                ) : null}
              </tbody>
            </table>
          </div>
        </>
      ) : null}
    </section>
  );
}

function Stat({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone?: "warning" | "neutral";
}) {
  const toneClass =
    tone === "warning"
      ? "border-amber-500/50 bg-amber-500/10 text-amber-100"
      : "border-line bg-muted/40 text-white";
  return (
    <div
      className={`rounded-lg border ${toneClass} px-3 py-2`}
      data-stat={label.toLowerCase().replace(/\s+/g, "-")}
    >
      <div className="text-xs uppercase tracking-wider text-white/50">
        {label}
      </div>
      <div className="mt-1 text-xl font-semibold">{value}</div>
    </div>
  );
}
