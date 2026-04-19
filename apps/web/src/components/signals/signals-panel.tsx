"use client";

import { useCallback, useEffect, useState } from "react";
import { formatDistanceToNow } from "date-fns";

interface Signal {
  id: string;
  ruleId: string;
  severity: "info" | "warn" | "critical";
  title: string;
  body: string | null;
  createdAt: string;
}

/**
 * Open signals scoped to a single subject (deal / contact / org).
 * Renders inline on the subject's detail page so operators see
 * open issues right above the data without having to jump to the
 * global /app/signals inbox.
 */
export function SignalsPanel({
  subjectType,
  subjectId,
}: {
  subjectType: "fuel_deal" | "organization" | "contact" | "follow_up";
  subjectId: string;
}): React.ReactElement | null {
  const [signals, setSignals] = useState<Signal[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [acking, setAcking] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const qs = new URLSearchParams({
        subject_type: subjectType,
        subject_id: subjectId,
      });
      const res = await fetch(`/api/signals?${qs.toString()}`);
      if (!res.ok) throw new Error(`${res.status}`);
      const body = (await res.json()) as { signals: Signal[] };
      setSignals(body.signals);
    } catch (err) {
      setError((err as Error).message);
      setSignals([]);
    }
  }, [subjectType, subjectId]);

  useEffect(() => {
    void load();
  }, [load]);

  async function acknowledge(id: string): Promise<void> {
    setAcking(id);
    try {
      const res = await fetch(`/api/signals/${id}/acknowledge`, {
        method: "POST",
      });
      if (!res.ok) throw new Error(`${res.status}`);
      await load();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setAcking(null);
    }
  }

  // Hide the section entirely when there are no open signals —
  // empty state on every record clutters the UI.
  if (signals !== null && signals.length === 0 && !error) return null;
  if (signals === null) return null;

  return (
    <div className="rounded-lg border border-warn/40 bg-warn/5 p-4">
      <div className="mb-2 flex items-center gap-2">
        <span className="text-xs font-medium uppercase tracking-wide text-warn">
          Open signals ({signals.length})
        </span>
      </div>
      {error && (
        <div className="mb-2 rounded-md border border-bad/40 bg-bad/10 px-2 py-1 text-xs text-bad">
          {error}
        </div>
      )}
      <ol className="flex flex-col gap-2">
        {signals.map((s) => (
          <li
            key={s.id}
            className="rounded-md border border-line/60 bg-canvas/40 px-3 py-2"
            data-severity={s.severity}
          >
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <SeverityPill severity={s.severity} />
                  <span className="font-mono text-[10px] text-white/40">
                    {s.ruleId}
                  </span>
                </div>
                <div className="mt-1 text-sm text-white">{s.title}</div>
                {s.body && (
                  <div className="mt-0.5 whitespace-pre-wrap text-xs text-white/60">
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
                <button
                  type="button"
                  onClick={() => void acknowledge(s.id)}
                  disabled={acking === s.id}
                  className="rounded-md border border-line bg-muted/40 px-2 py-1 text-xs text-white/80 hover:bg-muted/60 disabled:opacity-40"
                >
                  {acking === s.id ? "…" : "Acknowledge"}
                </button>
              </div>
            </div>
          </li>
        ))}
      </ol>
    </div>
  );
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
