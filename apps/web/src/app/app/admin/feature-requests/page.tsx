"use client";

import { useCallback, useEffect, useState } from "react";
import { formatDistanceToNow } from "date-fns";

/**
 * /app/admin/feature-requests — capability-gap feed.
 *
 * Lists chat.unsupported_request events so operators can see what
 * users are asking for that the current action catalogue can't
 * deliver. Newest first, keyset-paginated by occurredAt.
 */

interface FeatureRequest {
  id: string;
  occurredAt: string;
  actorId: string | null;
  originalCommand: string;
  reason: string;
  suggestion: string | null;
}

interface FeedResponse {
  items: FeatureRequest[];
  nextBefore: string | null;
}

export default function FeatureRequestsPage(): React.ReactElement {
  const [items, setItems] = useState<FeatureRequest[]>([]);
  const [nextBefore, setNextBefore] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(
    async (before: string | null, append: boolean): Promise<void> => {
      setLoading(true);
      setError(null);
      try {
        const qs = new URLSearchParams();
        qs.set("limit", "50");
        if (before) qs.set("before", before);
        const res = await fetch(`/api/admin/feature-requests?${qs.toString()}`);
        if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
        const body = (await res.json()) as FeedResponse;
        setItems((prev) => (append ? [...prev, ...body.items] : body.items));
        setNextBefore(body.nextBefore);
      } catch (err) {
        setError((err as Error).message);
      } finally {
        setLoading(false);
      }
    },
    [],
  );

  useEffect(() => {
    void load(null, false);
  }, [load]);

  return (
    <div className="mx-auto flex max-w-4xl flex-col gap-4 px-6 py-6">
      <header>
        <h1 className="text-xl font-semibold text-white">Feature requests</h1>
        <p className="mt-1 text-xs text-white/50">
          Chat commands Vex couldn&apos;t fulfil because no action in the current
          catalogue matched. Review periodically and prioritise the
          highest-frequency gaps as new action types.
        </p>
      </header>

      {error && (
        <div className="rounded-md border border-bad/40 bg-bad/10 px-3 py-2 text-sm text-bad">
          Couldn&apos;t load feed: {error}
        </div>
      )}

      {!loading && items.length === 0 && !error && (
        <div className="rounded-lg border border-line bg-muted/20 p-6 text-center text-sm text-white/50">
          No unsupported requests logged yet. When users ask Vex for something
          outside the current action catalogue, the attempts will land here.
        </div>
      )}

      <ol className="flex flex-col gap-2">
        {items.map((item) => (
          <li
            key={item.id}
            data-testid="feature-request-row"
            className="rounded-lg border border-line bg-muted/20 p-4"
          >
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0 flex-1">
                <div className="text-sm text-white whitespace-pre-wrap">
                  &ldquo;{item.originalCommand}&rdquo;
                </div>
                <div className="mt-1 text-xs text-white/60">
                  <span className="text-white/50">Why Vex couldn&apos;t: </span>
                  {item.reason}
                </div>
                {item.suggestion && (
                  <div className="mt-1 text-xs text-accent">
                    <span className="text-white/50">Closest fit: </span>
                    {item.suggestion}
                  </div>
                )}
              </div>
              <div className="text-right text-[11px] text-white/40 whitespace-nowrap">
                <div>
                  {formatDistanceToNow(new Date(item.occurredAt), {
                    addSuffix: true,
                  })}
                </div>
                {item.actorId && (
                  <div className="mt-0.5 font-mono">
                    {item.actorId.slice(-8)}
                  </div>
                )}
              </div>
            </div>
          </li>
        ))}
      </ol>

      {nextBefore && (
        <button
          type="button"
          onClick={() => void load(nextBefore, true)}
          disabled={loading}
          className="mx-auto mt-2 rounded-md border border-line bg-muted/40 px-3 py-1.5 text-sm text-white/70 hover:bg-muted/60 disabled:opacity-50"
        >
          {loading ? "Loading…" : "Load older"}
        </button>
      )}
    </div>
  );
}
