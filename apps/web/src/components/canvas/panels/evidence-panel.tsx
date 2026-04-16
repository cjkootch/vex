"use client";

import { useState } from "react";
import { formatDistanceToNow } from "date-fns";
import type { ManifestPanel } from "@vex/ui";

type EvidenceProps = Extract<ManifestPanel, { type: "evidence" }>;
type EvidenceItem = EvidenceProps["items"][number];

function freshnessClass(hours: number): string {
  if (hours <= 24) return "bg-good";
  if (hours <= 24 * 7) return "bg-warn";
  return "bg-bad";
}

export function EvidencePanel({ items }: EvidenceProps) {
  const [expanded, setExpanded] = useState(false);
  const [openItems, setOpenItems] = useState<Set<string>>(() => new Set());
  const visible = expanded ? items : items.slice(0, 3);

  return (
    <section
      data-panel="evidence"
      className="rounded-lg border border-line bg-muted/40 p-4"
    >
      <button
        type="button"
        className="flex w-full items-center justify-between text-left"
        onClick={() => setExpanded((v) => !v)}
      >
        <h3 className="text-sm font-semibold text-white">
          Evidence ({items.length})
        </h3>
        <span className="text-xs text-white/50">{expanded ? "Hide" : "Show all"}</span>
      </button>

      <ul className="mt-3 space-y-2">
        {visible.map((item) => (
          <EvidenceRow
            key={item.chunk_id}
            item={item}
            open={openItems.has(item.chunk_id)}
            onToggle={() =>
              setOpenItems((prev) => {
                const next = new Set(prev);
                if (next.has(item.chunk_id)) next.delete(item.chunk_id);
                else next.add(item.chunk_id);
                return next;
              })
            }
          />
        ))}
      </ul>
    </section>
  );
}

function EvidenceRow({
  item,
  open,
  onToggle,
}: {
  item: EvidenceItem;
  open: boolean;
  onToggle: () => void;
}) {
  const occurred = item.occurred_at ? new Date(item.occurred_at) : null;
  const relative = occurred ? formatDistanceToNow(occurred, { addSuffix: true }) : "no timestamp";
  const isWeak = /weak/i.test(item.source_ref);
  return (
    <li className="rounded border border-line/60 bg-canvas/40 p-2 text-xs">
      <button type="button" onClick={onToggle} className="flex w-full items-center gap-3 text-left">
        <span className="rounded bg-white/10 px-1.5 py-0.5 uppercase tracking-wider text-white/60">
          {item.source_ref.split(" ")[0]}
        </span>
        <span className="text-white/60">{relative}</span>
        <span
          aria-label="freshness"
          title={`${item.freshness_hours.toFixed(1)}h old`}
          className={`inline-block h-2 w-2 rounded-full ${freshnessClass(item.freshness_hours)}`}
        />
        <span className="ml-auto flex items-center gap-2">
          {isWeak && (
            <span className="rounded bg-warn/20 px-1.5 py-0.5 text-warn">Weak signal</span>
          )}
          <ConfidenceBar value={item.confidence_score} />
          <span className="font-mono text-white/40">{open ? "−" : "+"}</span>
        </span>
      </button>
      {open && (
        <p
          data-evidence-chunk-id={item.chunk_id}
          className="mt-2 whitespace-pre-wrap rounded bg-white/5 p-2 text-white/80"
        >
          chunk_id: <code>{item.chunk_id}</code>
          {"\n"}
          source: {item.source_ref}
        </p>
      )}
    </li>
  );
}

function ConfidenceBar({ value }: { value: number }) {
  const pct = Math.max(0, Math.min(1, value)) * 100;
  return (
    <span className="flex items-center gap-1">
      <span className="text-[10px] text-white/40">conf</span>
      <span className="h-1.5 w-16 overflow-hidden rounded bg-white/10">
        <span
          className="block h-full bg-accent"
          style={{ width: `${pct}%` }}
        />
      </span>
    </span>
  );
}
