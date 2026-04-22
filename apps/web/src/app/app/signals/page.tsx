"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { formatDistanceToNow } from "date-fns";
import { downloadCsv, toCsv } from "@/lib/csv";

/**
 * /app/signals — proactive-signal inbox.
 *
 * Signals are workspace alerts surfaced by the cron-run rule engine
 * (worker/jobs/signals-job.ts). Operators review unacknowledged
 * rows newest-first and acknowledge when they've handled the
 * underlying condition.
 */

interface Signal {
  id: string;
  ruleId: string;
  severity: "info" | "warn" | "critical";
  subjectType: string | null;
  subjectId: string | null;
  title: string;
  body: string | null;
  metadata: Record<string, unknown>;
  createdAt: string;
  acknowledgedAt: string | null;
}

export default function SignalsPage(): React.ReactElement {
  const [signals, setSignals] = useState<Signal[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [includeAcknowledged, setIncludeAcknowledged] = useState(false);
  const [acking, setAcking] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const qs = includeAcknowledged ? "?include=all" : "";
      const res = await fetch(`/api/signals${qs}`);
      if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
      const body = (await res.json()) as { signals: Signal[] };
      setSignals(body.signals);
    } catch (err) {
      setError((err as Error).message);
      setSignals([]);
    }
  }, [includeAcknowledged]);

  useEffect(() => {
    void load();
  }, [load]);

  async function acknowledge(id: string): Promise<void> {
    setAcking(id);
    try {
      const res = await fetch(`/api/signals/${id}/acknowledge`, {
        method: "POST",
      });
      if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
      await load();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setAcking(null);
    }
  }

  return (
    <div className="mx-auto flex max-w-4xl flex-col gap-4 px-6 py-6">
      <header className="flex flex-wrap items-end justify-between gap-4 border-b border-line-soft pb-5">
        <div>
          <div className="text-eyebrow text-text-muted">Now · Intelligence</div>
          <h1 className="mt-1 text-title text-text-primary">Signals</h1>
          <p className="mt-2 text-sm text-text-secondary">
            Proactive alerts — conditions Vex surfaces without being asked.
            Acknowledge to clear once handled.
          </p>
        </div>
        <div className="flex items-center gap-3">
          <button
            type="button"
            disabled={!signals || signals.length === 0}
            onClick={() => {
              if (!signals) return;
              const csv = toCsv(
                [
                  "id",
                  "rule_id",
                  "severity",
                  "subject_type",
                  "subject_id",
                  "title",
                  "body",
                  "created_at",
                  "acknowledged_at",
                ],
                signals.map((s) => [
                  s.id,
                  s.ruleId,
                  s.severity,
                  s.subjectType ?? "",
                  s.subjectId ?? "",
                  s.title,
                  s.body ?? "",
                  s.createdAt,
                  s.acknowledgedAt ?? "",
                ]),
              );
              downloadCsv(
                `signals-${new Date().toISOString().slice(0, 10)}.csv`,
                csv,
              );
            }}
            className="rounded-md border border-line bg-muted/40 px-3 py-1 text-xs text-white/80 hover:bg-muted/60 disabled:opacity-40"
          >
            Download CSV
          </button>
          <label className="flex items-center gap-2 text-xs text-white/60">
            <input
              type="checkbox"
              checked={includeAcknowledged}
              onChange={(e) => setIncludeAcknowledged(e.target.checked)}
              className="rounded border-line bg-canvas"
            />
            Show acknowledged
          </label>
        </div>
      </header>

      {error && (
        <div className="rounded-md border border-bad/40 bg-bad/10 px-3 py-2 text-sm text-bad">
          {error}
        </div>
      )}

      {signals === null ? (
        <div className="text-sm text-white/50">Loading…</div>
      ) : signals.length === 0 ? (
        <div className="rounded-lg border border-line bg-muted/20 p-6 text-center text-sm text-white/50">
          No open signals. The rule engine runs every 10 minutes — conditions
          will appear here when they trigger.
        </div>
      ) : (
        <ol className="flex flex-col gap-2">
          {signals.map((s) => (
            <li
              key={s.id}
              data-testid="signal-row"
              data-severity={s.severity}
              className={`rounded-lg border p-4 ${severityBorder(s.severity)} ${
                s.acknowledgedAt ? "opacity-50" : ""
              }`}
            >
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <SeverityPill severity={s.severity} />
                    <SubjectLink
                      subjectType={s.subjectType}
                      subjectId={s.subjectId}
                    />
                    <span className="font-mono text-[10px] text-white/30">
                      {s.ruleId}
                    </span>
                  </div>
                  <div className="mt-1 text-sm text-white">{s.title}</div>
                  {s.body && (
                    <div className="mt-1 whitespace-pre-wrap text-xs text-white/60">
                      {s.body}
                    </div>
                  )}
                </div>
                <div className="flex shrink-0 flex-col items-end gap-2 text-[11px] text-white/40">
                  <span>
                    {formatDistanceToNow(new Date(s.createdAt), {
                      addSuffix: true,
                    })}
                  </span>
                  {!s.acknowledgedAt && (
                    <button
                      type="button"
                      onClick={() => void acknowledge(s.id)}
                      disabled={acking === s.id}
                      className="rounded-md border border-line bg-muted/40 px-2 py-1 text-xs text-white/80 hover:bg-muted/60 disabled:opacity-40"
                    >
                      {acking === s.id ? "…" : "Acknowledge"}
                    </button>
                  )}
                  {s.acknowledgedAt && (
                    <span>
                      ack&apos;d{" "}
                      {formatDistanceToNow(new Date(s.acknowledgedAt), {
                        addSuffix: true,
                      })}
                    </span>
                  )}
                </div>
              </div>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

function SubjectLink({
  subjectType,
  subjectId,
}: {
  subjectType: string | null;
  subjectId: string | null;
}): React.ReactElement | null {
  if (!subjectType || !subjectId) return null;
  const href = hrefFor(subjectType, subjectId);
  const label = `${subjectType} ${subjectId.slice(-8)}`;
  if (!href) {
    return <span className="text-[11px] text-white/50">{label}</span>;
  }
  return (
    <Link href={href} className="text-[11px] text-accent hover:underline">
      {label}
    </Link>
  );
}

function hrefFor(
  subjectType: string,
  subjectId: string,
): string | null {
  if (subjectType === "fuel_deal") return `/app/deals/${subjectId}`;
  if (subjectType === "contact") return `/app/contacts/${subjectId}`;
  if (subjectType === "organization") return `/app/companies/${subjectId}`;
  if (subjectType === "follow_up") return `/app/follow-ups`;
  return null;
}

function SeverityPill({
  severity,
}: {
  severity: Signal["severity"];
}): React.ReactElement {
  const palette: Record<Signal["severity"], string> = {
    info: "bg-muted/60 text-white/70",
    warn: "bg-warn/20 text-warn",
    critical: "bg-bad/20 text-bad",
  };
  return (
    <span
      className={`rounded px-1.5 py-0.5 text-[10px] uppercase tracking-wide ${palette[severity]}`}
    >
      {severity}
    </span>
  );
}

function severityBorder(severity: Signal["severity"]): string {
  if (severity === "critical") return "border-bad/40 bg-bad/5";
  if (severity === "warn") return "border-warn/30 bg-warn/5";
  return "border-line bg-muted/20";
}
