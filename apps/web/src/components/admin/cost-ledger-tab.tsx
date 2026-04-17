"use client";

import { useEffect, useState } from "react";

interface CostLedgerEntry {
  id: string;
  operation: string;
  provider: string;
  model: string | null;
  agentName: string | null;
  units: number;
  unitKind: string;
  costUsd: number;
  occurredAt: string;
}

interface CostLedgerPage {
  window: { from: string; to: string };
  entries: CostLedgerEntry[];
  totals: {
    today: number;
    week: number;
    month: number;
  };
}

function isoDateOnly(d: Date): string {
  return d.toISOString().slice(0, 10);
}

const DEFAULT_FROM = (() => {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - 7);
  return isoDateOnly(d);
})();
const DEFAULT_TO = isoDateOnly(new Date());

/**
 * Cost ledger browser. From / to dates are yyyy-mm-dd; the proxy
 * forwards them through to apps/api which parses as inclusive
 * window. Totals come from the same endpoint response.
 */
export function CostLedgerTab() {
  const [from, setFrom] = useState<string>(DEFAULT_FROM);
  const [to, setTo] = useState<string>(DEFAULT_TO);
  const [page, setPage] = useState<CostLedgerPage | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const qs = new URLSearchParams({ from, to });
        const res = await fetch(`/api/admin/cost-ledger?${qs.toString()}`, {
          credentials: "include",
          cache: "no-store",
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const body = (await res.json()) as CostLedgerPage;
        if (!cancelled) {
          setPage(body);
          setError(null);
        }
      } catch (err) {
        if (!cancelled) setError((err as Error).message);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [from, to, nonce]);

  return (
    <section className="space-y-6">
      <div className="flex flex-wrap items-end gap-3">
        <label className="flex flex-col gap-1 text-xs text-white/60">
          From
          <input
            type="date"
            value={from}
            onChange={(e) => setFrom(e.target.value)}
            className="rounded-md border border-line bg-canvas/40 px-2 py-1 text-sm text-white"
          />
        </label>
        <label className="flex flex-col gap-1 text-xs text-white/60">
          To
          <input
            type="date"
            value={to}
            onChange={(e) => setTo(e.target.value)}
            className="rounded-md border border-line bg-canvas/40 px-2 py-1 text-sm text-white"
          />
        </label>
        <button
          type="button"
          onClick={() => setNonce((n) => n + 1)}
          className="rounded-md border border-line bg-muted/40 px-3 py-1 text-sm text-white/80 transition hover:border-white/30 hover:text-white"
        >
          Refresh
        </button>
      </div>

      {page ? (
        <div className="grid grid-cols-3 gap-3">
          <Totals label="Today" value={page.totals.today} />
          <Totals label="This week" value={page.totals.week} />
          <Totals label="This month" value={page.totals.month} />
        </div>
      ) : null}

      {error ? (
        <p className="text-sm text-red-400">
          Couldn&rsquo;t load cost ledger: {error}
        </p>
      ) : null}

      {!page && !error ? (
        <p className="text-sm text-white/50">Loading entries…</p>
      ) : null}

      {page ? (
        <table
          className="w-full border-separate border-spacing-0 overflow-hidden rounded-lg border border-line bg-muted/20 text-sm"
          data-table="cost-ledger"
        >
          <thead>
            <tr className="text-left text-xs uppercase tracking-wider text-white/50">
              <th className="px-4 py-2 font-medium">When</th>
              <th className="px-4 py-2 font-medium">Operation</th>
              <th className="px-4 py-2 font-medium">Agent</th>
              <th className="px-4 py-2 font-medium">Model</th>
              <th className="px-4 py-2 font-medium text-right">Units</th>
              <th className="px-4 py-2 font-medium text-right">Cost</th>
            </tr>
          </thead>
          <tbody>
            {page.entries.map((e) => (
              <tr key={e.id} className="border-t border-line/60 text-white/80">
                <td className="px-4 py-2 font-mono text-xs text-white/60">
                  {new Date(e.occurredAt).toLocaleString(undefined, {
                    month: "short",
                    day: "numeric",
                    hour: "2-digit",
                    minute: "2-digit",
                  })}
                </td>
                <td className="px-4 py-2">{e.operation}</td>
                <td className="px-4 py-2 font-mono text-xs text-white/60">
                  {e.agentName ?? "—"}
                </td>
                <td className="px-4 py-2 font-mono text-xs text-white/60">
                  {e.model ?? "—"}
                </td>
                <td className="px-4 py-2 text-right tabular-nums text-white/70">
                  {e.units.toLocaleString()}{" "}
                  <span className="text-white/40">{e.unitKind}</span>
                </td>
                <td className="px-4 py-2 text-right font-medium tabular-nums">
                  ${e.costUsd.toFixed(4)}
                </td>
              </tr>
            ))}
            {page.entries.length === 0 ? (
              <tr>
                <td
                  colSpan={6}
                  className="px-4 py-6 text-center text-xs text-white/40"
                >
                  No entries in the window.
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      ) : null}
    </section>
  );
}

function Totals({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-lg border border-line bg-muted/40 px-3 py-2">
      <div className="text-xs uppercase tracking-wider text-white/50">
        {label}
      </div>
      <div className="mt-1 text-lg font-semibold text-white tabular-nums">
        ${value.toFixed(2)}
      </div>
    </div>
  );
}
