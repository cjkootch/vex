"use client";

import { useEffect, useState } from "react";

interface EvalFixtureResult {
  id: string;
  question: string;
  passed: boolean;
  errors?: string[];
}

interface EvalResults {
  runAt: string;
  totalFixtures: number;
  passed: number;
  failed: number;
  passRate: number;
  regressions?: string[];
  fixtures: EvalFixtureResult[];
}

type Response =
  | { status: "ok"; results: EvalResults }
  | { status: "no_results"; message: string };

/**
 * Eval scorecard from the last CI run. Reads /api/admin/evals/latest
 * which proxies to apps/api; apps/api reads evals/results/latest.json
 * written by the eval runner (wired in Group 4).
 *
 * Regression alerts: when `results.regressions[]` is non-empty,
 * render a prominent red banner listing each fixture that passed on
 * the previous run and now fails.
 */
export function EvalsTab() {
  const [state, setState] = useState<Response | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/admin/evals/latest", {
          credentials: "include",
          cache: "no-store",
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const body = (await res.json()) as Response;
        if (!cancelled) {
          setState(body);
          setError(null);
        }
      } catch (err) {
        if (!cancelled) setError((err as Error).message);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  if (error) {
    return <p className="text-sm text-red-400">Couldn&rsquo;t load evals: {error}</p>;
  }
  if (!state) return <p className="text-sm text-white/50">Loading evals…</p>;
  if (state.status === "no_results") {
    return (
      <p className="text-sm text-white/60">
        No eval run results yet. Run{" "}
        <code className="font-mono text-white/80">pnpm --filter=@vex/agents eval:run</code>{" "}
        locally or wait for the next CI run.
      </p>
    );
  }

  const { results } = state;
  const passPct = Math.round(results.passRate * 100);
  const regressions = results.regressions ?? [];

  return (
    <section className="space-y-6">
      {regressions.length > 0 ? (
        <div
          role="alert"
          data-regressions="present"
          className="rounded-lg border border-red-500/60 bg-red-500/10 p-4"
        >
          <h2 className="text-sm font-semibold uppercase tracking-wider text-red-200">
            Regression
          </h2>
          <p className="mt-1 text-sm text-white/80">
            {regressions.length} fixture{regressions.length === 1 ? "" : "s"}{" "}
            passed on the previous run and fail now.
          </p>
          <ul className="mt-2 flex flex-wrap gap-2">
            {regressions.map((id) => (
              <li
                key={id}
                className="rounded-full border border-red-500/40 bg-red-500/10 px-2 py-0.5 font-mono text-xs text-red-200"
              >
                {id}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Stat label="Run at" value={formatRunAt(results.runAt)} />
        <Stat
          label="Pass rate"
          value={`${passPct}%`}
          tone={passPct >= 85 ? "good" : "warning"}
        />
        <Stat label="Passed" value={results.passed.toString()} />
        <Stat
          label="Failed"
          value={results.failed.toString()}
          tone={results.failed > 0 ? "warning" : "neutral"}
        />
      </div>

      <div>
        <h3 className="mb-2 text-xs font-semibold uppercase tracking-wider text-white/50">
          Fixtures
        </h3>
        <ul
          className="divide-y divide-line/60 rounded-lg border border-line bg-muted/20"
          data-list="fixtures"
        >
          {results.fixtures.map((f) => (
            <li
              key={f.id}
              data-fixture={f.id}
              data-passed={f.passed ? "true" : "false"}
              className="flex items-start gap-3 px-4 py-3 text-sm"
            >
              <span
                aria-hidden="true"
                className={`mt-1.5 h-2 w-2 flex-shrink-0 rounded-full ${
                  f.passed ? "bg-emerald-400" : "bg-red-500"
                }`}
              />
              <div className="min-w-0 flex-1">
                <div className="flex items-baseline gap-2">
                  <span className="font-mono text-xs text-white/60">{f.id}</span>
                  <span className="truncate text-white/80">{f.question}</span>
                </div>
                {!f.passed && f.errors && f.errors.length > 0 ? (
                  <ul className="mt-1 space-y-0.5">
                    {f.errors.map((e, i) => (
                      <li key={i} className="text-xs text-red-300">
                        &mdash; {e}
                      </li>
                    ))}
                  </ul>
                ) : null}
              </div>
            </li>
          ))}
        </ul>
      </div>
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
  tone?: "good" | "warning" | "neutral";
}) {
  const toneClass =
    tone === "good"
      ? "border-emerald-400/50 bg-emerald-500/10 text-emerald-100"
      : tone === "warning"
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
      <div className="mt-1 text-lg font-semibold tabular-nums">{value}</div>
    </div>
  );
}

function formatRunAt(iso: string): string {
  try {
    return new Date(iso).toLocaleString(undefined, {
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return iso;
  }
}
