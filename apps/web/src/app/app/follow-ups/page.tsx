"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { formatDistanceToNow, isPast } from "date-fns";

/**
 * /app/follow-ups — scheduled reminders + assigned tasks.
 *
 * Listed sorted by due_at (overdue on top). Each row has Complete +
 * Cancel buttons; clicking deep-links into the subject (contact,
 * org, deal) when one is set.
 */

interface FollowUp {
  id: string;
  title: string;
  note: string | null;
  dueAt: string;
  subjectType: string | null;
  subjectId: string | null;
  assignedTo: string | null;
  status: "open" | "completed" | "cancelled";
  createdBy: string;
  createdAt: string;
}

export default function FollowUpsPage(): React.ReactElement {
  const [items, setItems] = useState<FollowUp[]>([]);
  const [loading, setLoading] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/follow-ups?status=open");
      if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
      const body = (await res.json()) as { follow_ups: FollowUp[] };
      setItems(body.follow_ups);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const act = useCallback(
    async (id: string, kind: "complete" | "cancel") => {
      const prev = items;
      setItems((list) => list.filter((f) => f.id !== id));
      try {
        const res = await fetch(`/api/follow-ups/${id}/${kind}`, {
          method: "POST",
        });
        if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
      } catch (err) {
        setItems(prev);
        setError((err as Error).message);
      }
    },
    [items],
  );

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-4 px-6 py-6">
      <header>
        <h1 className="text-xl font-semibold text-white">Follow-ups</h1>
        <p className="mt-1 text-xs text-white/50">
          Scheduled reminders + assigned tasks. Sorted by due date — overdue
          surface on top.
        </p>
      </header>

      {error && (
        <div className="rounded-md border border-bad/40 bg-bad/10 px-3 py-2 text-sm text-bad">
          Couldn&apos;t load follow-ups: {error}
        </div>
      )}

      {!loading && items.length === 0 && !error && (
        <div className="rounded-lg border border-line bg-muted/20 p-6 text-center text-sm text-white/50">
          No open follow-ups. Ask Vex to schedule one:{" "}
          <span className="font-mono text-white/70">
            &ldquo;remind me about Acme next Thursday&rdquo;
          </span>
          .
        </div>
      )}

      <ol className="flex flex-col gap-2">
        {items.map((f) => {
          const due = new Date(f.dueAt);
          const overdue = isPast(due) && f.status === "open";
          return (
            <li
              key={f.id}
              data-testid="follow-up-row"
              data-overdue={overdue}
              className={`flex flex-col gap-2 rounded-lg border px-3 py-3 ${
                overdue
                  ? "border-bad/40 bg-bad/10"
                  : "border-line bg-muted/20"
              }`}
            >
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="text-sm text-white">{f.title}</div>
                  {f.note && (
                    <div className="mt-1 text-xs text-white/60">{f.note}</div>
                  )}
                  <div className="mt-2 flex flex-wrap gap-3 text-[11px] text-white/50">
                    <span
                      className={
                        overdue ? "font-medium text-bad" : "text-white/70"
                      }
                    >
                      {overdue ? "Overdue " : "Due "}
                      {formatDistanceToNow(due, { addSuffix: true })}
                    </span>
                    {f.assignedTo && (
                      <span>Assigned: {f.assignedTo}</span>
                    )}
                    {f.subjectType && f.subjectId && (
                      <SubjectLink
                        type={f.subjectType}
                        id={f.subjectId}
                      />
                    )}
                  </div>
                </div>
                <div className="flex flex-shrink-0 flex-col gap-1">
                  <button
                    type="button"
                    data-testid="follow-up-complete"
                    onClick={() => void act(f.id, "complete")}
                    className="rounded-md bg-good/20 px-2 py-1 text-xs text-good hover:bg-good/30"
                  >
                    Complete
                  </button>
                  <button
                    type="button"
                    data-testid="follow-up-cancel"
                    onClick={() => void act(f.id, "cancel")}
                    className="rounded-md border border-line px-2 py-1 text-xs text-white/60 hover:bg-muted/40"
                  >
                    Cancel
                  </button>
                </div>
              </div>
            </li>
          );
        })}
      </ol>
    </div>
  );
}

function SubjectLink({
  type,
  id,
}: {
  type: string;
  id: string;
}): React.ReactElement {
  const href =
    type === "contact"
      ? `/app/contacts/${id}`
      : type === "organization"
        ? `/app/companies/${id}`
        : type === "deal"
          ? `/app/deals/${id}`
          : type === "campaign"
            ? `/app/marketing/${id}`
            : null;
  if (!href) return <span>{`${type}:${id.slice(0, 8)}`}</span>;
  return (
    <Link href={href} className="text-accent hover:underline">
      {type} →
    </Link>
  );
}
