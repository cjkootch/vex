"use client";

import { formatDistanceToNow } from "date-fns";
import type { ManifestPanel } from "@vex/ui";

type TimelineProps = Extract<ManifestPanel, { type: "timeline" }>;

const VERB_COLORS: Array<{ match: RegExp; className: string }> = [
  { match: /^call\./, className: "bg-blue-500" },
  { match: /^email\./, className: "bg-good" },
  { match: /^web\./, className: "bg-purple-500" },
  { match: /^internal\./, className: "bg-white/30" },
];

function dotColor(verb: string): string {
  for (const c of VERB_COLORS) if (c.match.test(verb)) return c.className;
  return "bg-white/30";
}

export function TimelinePanel({ title, events }: TimelineProps) {
  const sorted = [...events].sort(
    (a, b) => new Date(b.occurred_at).getTime() - new Date(a.occurred_at).getTime(),
  );
  return (
    <section
      data-panel="timeline"
      className="rounded-lg border border-line bg-muted/40 p-4"
    >
      <h3 className="mb-3 text-sm font-semibold text-white">{title}</h3>
      {sorted.length === 0 ? (
        <p className="text-sm text-white/50">No events.</p>
      ) : (
        <ol className="space-y-3">
          {sorted.map((e, i) => {
            const date = new Date(e.occurred_at);
            const valid = !Number.isNaN(date.getTime());
            const relative = valid ? formatDistanceToNow(date, { addSuffix: true }) : e.occurred_at;
            const absolute = valid ? date.toISOString() : e.occurred_at;
            return (
              <li key={i} className="flex items-start gap-3">
                <span
                  className={`mt-1.5 inline-block h-2 w-2 flex-none rounded-full ${dotColor(e.verb)}`}
                  aria-hidden
                />
                <div className="flex-1 text-sm">
                  <div className="flex items-baseline justify-between gap-2">
                    <span className="font-medium text-white">{e.verb}</span>
                    <span title={absolute} className="text-xs text-white/50">
                      {relative}
                    </span>
                  </div>
                  <p className="text-white/80">{e.summary}</p>
                  <p className="text-xs text-white/40">source: {e.source}</p>
                </div>
              </li>
            );
          })}
        </ol>
      )}
    </section>
  );
}
