"use client";

import { useCallback, useEffect, useState } from "react";
import { fetchWithRetry } from "@/lib/fetch-with-retry";

interface OfacSummary {
  counts: {
    unscreened: number;
    clear: number;
    potential_match: number;
    confirmed_match: number;
    cleared_by_operator: number;
  };
  lastScreenAt: string | null;
  totalOrgs: number;
}

interface OfacMatch {
  sdnUid: string;
  matchedName: string;
  score: number;
  matchType: string;
  programs: string[];
  sdnType: string;
  /**
   * Which CSL list the entry came from (BIS Entity, OFAC SDN, etc).
   * Optional for backward compatibility — historical rows written
   * before CSL ingestion landed are implicitly OFAC SDN.
   */
  sourceList?: string;
}

interface OfacScreenRow {
  id: string;
  orgId: string;
  orgName: string | null;
  status: string;
  highestScore: number;
  matchCount: number;
  matches: OfacMatch[] | unknown;
  screenedAt: string;
  clearedAt: string | null;
  clearedBy: string | null;
  clearedReason: string | null;
}

/**
 * Admin → OFAC tab. Status bar + potential-match review table +
 * run-now button. Every mutation refreshes both the summary and the
 * screen list so the numbers at the top match the rows below.
 */
export function OfacTab() {
  const [summary, setSummary] = useState<OfacSummary | null>(null);
  const [screens, setScreens] = useState<OfacScreenRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const [clearingId, setClearingId] = useState<string | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [clearReasons, setClearReasons] = useState<Record<string, string>>({});
  const [refreshIdx, setRefreshIdx] = useState(0);

  const reload = useCallback(() => setRefreshIdx((i) => i + 1), []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [summaryRes, screensRes] = await Promise.all([
          fetchWithRetry("/api/admin/ofac/summary", {
            credentials: "include",
            cache: "no-store",
          }),
          fetchWithRetry(
            "/api/admin/ofac/screens?status=potential_match,confirmed_match",
            {
              credentials: "include",
              cache: "no-store",
            },
          ),
        ]);
        if (!summaryRes.ok) throw new Error(`summary ${summaryRes.status}`);
        if (!screensRes.ok) throw new Error(`screens ${screensRes.status}`);
        const summaryBody = (await summaryRes.json()) as OfacSummary;
        const screensBody = (await screensRes.json()) as {
          screens: OfacScreenRow[];
        };
        if (!cancelled) {
          setSummary(summaryBody);
          setScreens(screensBody.screens);
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

  async function runScreen(): Promise<void> {
    if (running) return;
    setRunning(true);
    setError(null);
    try {
      const res = await fetchWithRetry("/api/admin/ofac/run", {
        method: "POST",
        credentials: "include",
      });
      if (!res.ok) {
        setError(`run failed: ${res.status}`);
        return;
      }
      // Screen runs asynchronously — give the worker a few seconds to
      // start writing rows, then reload.
      setTimeout(reload, 3000);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setRunning(false);
    }
  }

  async function clearMatch(id: string): Promise<void> {
    const reason = (clearReasons[id] ?? "").trim();
    if (!reason) {
      setError("A reason is required to clear a match.");
      return;
    }
    setClearingId(id);
    setError(null);
    try {
      const res = await fetchWithRetry(`/api/admin/ofac/clear/${id}`, {
        method: "PATCH",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ reason }),
      });
      if (!res.ok) {
        setError(`clear failed: ${res.status}`);
        return;
      }
      reload();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setClearingId(null);
    }
  }

  const counts = summary?.counts;
  const pending = (counts?.potential_match ?? 0) + (counts?.confirmed_match ?? 0);

  return (
    <div className="flex flex-col gap-6">
      {error && (
        <p className="rounded-md border border-bad/40 bg-bad/10 px-3 py-2 text-sm text-bad">
          {error}
        </p>
      )}

      <section className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-line bg-muted/40 p-4 text-sm">
        <div className="flex flex-wrap items-center gap-5">
          <Counter label="Active orgs" value={summary?.totalOrgs ?? 0} />
          <Counter
            label="Clear"
            value={counts?.clear ?? 0}
            tone="good"
          />
          <Counter
            label="Potential"
            value={counts?.potential_match ?? 0}
            {...((counts?.potential_match ?? 0) > 0 ? { tone: "bad" as const } : {})}
          />
          <Counter
            label="Confirmed"
            value={counts?.confirmed_match ?? 0}
            {...((counts?.confirmed_match ?? 0) > 0 ? { tone: "bad" as const } : {})}
          />
          <Counter
            label="Operator-cleared"
            value={counts?.cleared_by_operator ?? 0}
          />
          <Counter label="Unscreened" value={counts?.unscreened ?? 0} />
        </div>
        <div className="flex items-center gap-3">
          <div className="text-xs text-white/60">
            Last screen:{" "}
            <span className="text-white/80">
              {summary?.lastScreenAt
                ? new Date(summary.lastScreenAt).toLocaleString()
                : "never"}
            </span>
          </div>
          <button
            type="button"
            onClick={runScreen}
            disabled={running}
            className="rounded-md border border-line bg-accent/80 px-3 py-1.5 text-sm font-medium text-white hover:bg-accent disabled:opacity-40"
          >
            {running ? "Queuing…" : "Run screen now"}
          </button>
        </div>
      </section>

      <SanctionsSourcesPanel onPatchError={(msg) => setError(msg)} />

      <section>
        <header className="mb-2 flex items-center justify-between">
          <h2 className="text-sm font-semibold text-white">
            Pending review{pending > 0 ? ` (${pending})` : ""}
          </h2>
        </header>
        {screens.length === 0 ? (
          <p className="rounded-md border border-line bg-muted/40 px-3 py-2 text-sm text-white/60">
            No pending matches. The overnight screen will populate this
            list if anything new lands.
          </p>
        ) : (
          <div className="flex flex-col gap-2">
            {screens.map((row) => (
              <article
                key={row.id}
                className="rounded-md border border-bad/30 bg-bad/5 p-3 text-sm"
              >
                <header className="flex flex-wrap items-start justify-between gap-2">
                  <div>
                    <div className="font-semibold text-white">
                      {row.orgName ?? row.orgId}
                    </div>
                    <div className="text-xs text-white/60">
                      {row.status.replace(/_/g, " ")} · {row.matchCount}{" "}
                      {row.matchCount === 1 ? "match" : "matches"} · highest{" "}
                      {(row.highestScore * 100).toFixed(1)}%
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      onClick={() =>
                        setExpandedId((cur) => (cur === row.id ? null : row.id))
                      }
                      className="rounded-md border border-line px-2 py-1 text-xs text-white/70 hover:text-white"
                    >
                      {expandedId === row.id ? "Hide" : "View"} details
                    </button>
                  </div>
                </header>
                {expandedId === row.id && (
                  <div className="mt-3 flex flex-col gap-2">
                    <MatchList matches={row.matches} />
                    <div className="flex flex-col gap-1 rounded-md border border-line bg-canvas/40 p-2 text-xs">
                      <label className="text-white/60">
                        Reason for clearing (required)
                      </label>
                      <textarea
                        value={clearReasons[row.id] ?? ""}
                        onChange={(e) =>
                          setClearReasons((prev) => ({
                            ...prev,
                            [row.id]: e.target.value,
                          }))
                        }
                        rows={2}
                        className="rounded-md border border-line bg-canvas px-2 py-1 text-xs text-white outline-none focus:border-accent"
                        placeholder="e.g. Name collision with a different entity — verified different country of registration"
                      />
                      <div className="flex justify-end">
                        <button
                          type="button"
                          onClick={() => clearMatch(row.id)}
                          disabled={clearingId === row.id}
                          className="rounded-md border border-line bg-accent/70 px-3 py-1 text-xs font-medium text-white hover:bg-accent disabled:opacity-40"
                        >
                          {clearingId === row.id
                            ? "Clearing…"
                            : "Clear — not a match"}
                        </button>
                      </div>
                    </div>
                  </div>
                )}
              </article>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}

function Counter({
  label,
  value,
  tone,
}: {
  label: string;
  value: number;
  tone?: "good" | "bad";
}) {
  const toneClass =
    tone === "good" ? "text-good" : tone === "bad" ? "text-bad" : "text-white";
  return (
    <div>
      <div className="text-[10px] uppercase tracking-wide text-white/40">
        {label}
      </div>
      <div className={`text-base font-semibold tabular-nums ${toneClass}`}>
        {value}
      </div>
    </div>
  );
}

function MatchList({ matches }: { matches: OfacMatch[] | unknown }) {
  const list = Array.isArray(matches) ? (matches as OfacMatch[]) : [];
  if (list.length === 0) {
    return <p className="text-xs text-white/50">No match details stored.</p>;
  }
  return (
    <div className="overflow-x-auto rounded-md border border-line">
      <table className="w-full text-xs">
        <thead className="bg-muted/40 text-left text-[10px] uppercase tracking-wide text-white/50">
          <tr>
            <th className="px-2 py-1">List</th>
            <th className="px-2 py-1">Entry ID</th>
            <th className="px-2 py-1">Name</th>
            <th className="px-2 py-1">Type</th>
            <th className="px-2 py-1">Programs</th>
            <th className="px-2 py-1 text-right">Score</th>
          </tr>
        </thead>
        <tbody>
          {list.map((m) => (
            <tr
              key={`${m.sdnUid}:${m.matchedName}`}
              className="border-t border-line/60"
            >
              <td className="px-2 py-1">
                <SourceListChip source={m.sourceList} />
              </td>
              <td className="px-2 py-1 font-mono text-[11px] text-white/60">
                {m.sdnUid}
              </td>
              <td className="px-2 py-1 text-white">{m.matchedName}</td>
              <td className="px-2 py-1 text-white/70">{m.sdnType}</td>
              <td className="px-2 py-1 text-white/70">
                {m.programs.join(", ") || "—"}
              </td>
              <td className="px-2 py-1 text-right tabular-nums text-white">
                {(m.score * 100).toFixed(1)}%
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/**
 * Source-list chip. Tints by trust posture so reviewers visually
 * triage which lists routinely produce probable-cause noise (UVL,
 * NS-PLC) vs which always require a closer look (SDN, EL, DPL).
 *
 * Historical rows before CSL ingestion shipped lack `sourceList`; we
 * render them as "SDN" since that was the only list the legacy
 * adapter ingested.
 */
function SourceListChip({ source }: { source: string | undefined }) {
  const code = source ?? "SDN";
  const palette: Record<string, string> = {
    SDN: "bg-bad/20 text-bad",
    "NS-PLC": "bg-warn/20 text-warn",
    SSI: "bg-warn/20 text-warn",
    FSE: "bg-bad/20 text-bad",
    DPL: "bg-bad/20 text-bad",
    EL: "bg-bad/20 text-bad",
    UVL: "bg-warn/20 text-warn",
    MEU: "bg-bad/20 text-bad",
    DTC: "bg-bad/20 text-bad",
    ISN: "bg-bad/20 text-bad",
    CAP: "bg-warn/20 text-warn",
    EU: "bg-bad/20 text-bad",
    UK_OFSI: "bg-bad/20 text-bad",
    OTHER: "bg-muted/60 text-white/60",
  };
  return (
    <span
      className={`inline-block rounded px-1.5 py-0.5 font-mono text-[10px] ${
        palette[code] ?? palette["OTHER"]
      }`}
      title={SOURCE_LIST_TOOLTIPS[code] ?? code}
    >
      {code}
    </span>
  );
}

const SOURCE_LIST_TOOLTIPS: Record<string, string> = {
  SDN: "OFAC Specially Designated Nationals — Treasury",
  "NS-PLC": "OFAC Non-SDN Palestinian Legislative Council — Treasury",
  SSI: "OFAC Sectoral Sanctions Identifications — Treasury",
  FSE: "OFAC Foreign Sanctions Evaders — Treasury",
  DPL: "BIS Denied Persons List — Commerce",
  EL: "BIS Entity List — Commerce",
  UVL: "BIS Unverified List — Commerce (probable-cause-only signal)",
  MEU: "BIS Military End User List — Commerce",
  DTC: "State ITAR Debarred parties",
  ISN: "State Nonproliferation Sanctions",
  CAP: "State CAATSA section 231",
  EU: "European Council Consolidated Financial Sanctions",
  UK_OFSI:
    "UK Office of Financial Sanctions Implementation — consolidated targets",
  OTHER: "Source list unrecognised — see raw audit row",
};

type SanctionsSourceId = "us_csl" | "eu" | "uk_ofsi";

interface SourceOption {
  id: SanctionsSourceId;
  label: string;
  description: string;
}

const SOURCE_OPTIONS: SourceOption[] = [
  {
    id: "us_csl",
    label: "US Trade.gov CSL",
    description:
      "Treasury (SDN/NS-PLC/SSI/FSE) + Commerce/BIS (DPL/EL/UVL/MEU) + State (DTC/ISN/CAP). Default.",
  },
  {
    id: "eu",
    label: "EU Consolidated",
    description:
      "European Council Consolidated Financial Sanctions list. Required for EU counterparties.",
  },
  {
    id: "uk_ofsi",
    label: "UK OFSI",
    description:
      "UK Office of Financial Sanctions Implementation. Required for UK counterparties.",
  },
];

/**
 * Workspace-level toggle for which sanctions lists the screening
 * agent runs against. Default `["us_csl"]`. Persists via
 * PATCH /api/admin/settings.
 *
 * UX: optimistic — checkbox flips immediately, PATCH fires in the
 * background, revert + parent error on failure. Operators flipping
 * a list during a busy day shouldn't have to wait on the round-trip.
 */
function SanctionsSourcesPanel({
  onPatchError,
}: {
  onPatchError: (msg: string) => void;
}) {
  const [enabled, setEnabled] = useState<SanctionsSourceId[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [savingId, setSavingId] = useState<SanctionsSourceId | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetchWithRetry("/api/admin/settings", {
          credentials: "include",
          cache: "no-store",
        });
        if (!res.ok) throw new Error(`settings ${res.status}`);
        const body = (await res.json()) as {
          settings: { enabled_sanctions_lists?: SanctionsSourceId[] };
        };
        if (cancelled) return;
        setEnabled(body.settings.enabled_sanctions_lists ?? ["us_csl"]);
        setLoading(false);
      } catch (err) {
        if (cancelled) return;
        onPatchError((err as Error).message);
        setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [onPatchError]);

  async function toggle(id: SanctionsSourceId): Promise<void> {
    if (!enabled || savingId) return;
    const next = enabled.includes(id)
      ? enabled.filter((s) => s !== id)
      : [...enabled, id];
    // Block clearing all sources — the OFAC agent gates on at least
    // one being enabled. The empty-list path on the server reverts to
    // default ["us_csl"], but flipping every box off in the UI without
    // feedback is confusing; refuse instead.
    if (next.length === 0) {
      onPatchError(
        "At least one sanctions list must be enabled. Disabling all is not supported.",
      );
      return;
    }
    const previous = enabled;
    setEnabled(next);
    setSavingId(id);
    try {
      const res = await fetchWithRetry("/api/admin/settings", {
        method: "PATCH",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ enabled_sanctions_lists: next }),
      });
      if (!res.ok) {
        setEnabled(previous);
        onPatchError(`save failed: ${res.status}`);
      }
    } catch (err) {
      setEnabled(previous);
      onPatchError((err as Error).message);
    } finally {
      setSavingId(null);
    }
  }

  return (
    <section className="rounded-md border border-line bg-muted/40 p-4 text-sm">
      <header className="mb-3">
        <h2 className="text-sm font-semibold text-white">
          Sanctions sources
        </h2>
        <p className="mt-1 text-xs text-white/60">
          Which lists the screening agent runs against. Each enabled
          list contributes its own match rows; reviewers see a chip on
          every row indicating the source. Default is US CSL only.
        </p>
      </header>
      {loading ? (
        <p className="text-xs text-white/40">Loading…</p>
      ) : (
        <ul className="flex flex-col gap-2">
          {SOURCE_OPTIONS.map((opt) => {
            const checked = enabled?.includes(opt.id) ?? false;
            return (
              <li key={opt.id} className="flex items-start gap-2">
                <input
                  type="checkbox"
                  id={`sanctions-${opt.id}`}
                  checked={checked}
                  disabled={savingId !== null}
                  onChange={() => void toggle(opt.id)}
                  className="mt-0.5 h-4 w-4 cursor-pointer accent-accent disabled:opacity-40"
                />
                <label
                  htmlFor={`sanctions-${opt.id}`}
                  className="cursor-pointer flex-1"
                >
                  <span className="font-medium text-white">{opt.label}</span>
                  <span className="ml-2 text-xs text-white/60">
                    {opt.description}
                  </span>
                </label>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
