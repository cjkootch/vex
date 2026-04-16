"use client";

import { useState } from "react";

interface Props {
  evidenceRefs: string[];
  costUsd?: number;
  cacheHit?: boolean;
}

/**
 * Right-hand inspection panel. Shows the chunk_ids the assistant cited so
 * an analyst can audit which evidence drove the answer. Sprint 6 will add
 * full chunk text fetch via /api/evidence/{id}; for now the panel surfaces
 * the IDs + cost meta so the wiring is in place.
 */
export function EvidenceDetail({ evidenceRefs, costUsd, cacheHit }: Props) {
  const [collapsed, setCollapsed] = useState(false);
  if (collapsed) {
    return (
      <button
        type="button"
        onClick={() => setCollapsed(false)}
        className="absolute right-0 top-4 rounded-l-md border border-r-0 border-line bg-muted/80 px-2 py-3 text-xs text-white/60"
      >
        ◀ Evidence
      </button>
    );
  }
  return (
    <aside className="flex h-full w-80 flex-none flex-col border-l border-line bg-canvas/60">
      <header className="flex items-center justify-between border-b border-line p-3">
        <h3 className="text-sm font-semibold text-white">Evidence</h3>
        <button
          type="button"
          onClick={() => setCollapsed(true)}
          className="rounded p-1 text-xs text-white/50 hover:bg-white/5"
        >
          Hide ▶
        </button>
      </header>
      <div className="flex-1 overflow-y-auto p-3 text-xs">
        {evidenceRefs.length === 0 ? (
          <p className="text-white/40">No evidence cited yet.</p>
        ) : (
          <ul className="space-y-2" data-testid="evidence-detail-list">
            {evidenceRefs.map((ref) => (
              <li
                key={ref}
                className="rounded border border-line/60 bg-muted/40 p-2 font-mono text-[11px] text-white/80"
              >
                {ref}
              </li>
            ))}
          </ul>
        )}
      </div>
      <footer className="border-t border-line p-3 text-xs text-white/50">
        {typeof costUsd === "number" && (
          <div>cost: ${costUsd.toFixed(4)}</div>
        )}
        {typeof cacheHit === "boolean" && (
          <div>cache hit: {cacheHit ? "yes" : "no"}</div>
        )}
      </footer>
    </aside>
  );
}
