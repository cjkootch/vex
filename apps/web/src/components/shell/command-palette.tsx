"use client";

import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { useRouter } from "next/navigation";

interface SearchHit {
  kind: "organization" | "contact" | "deal";
  id: string;
  label: string;
  sublabel: string | null;
}

const KIND_ROUTE: Record<SearchHit["kind"], string> = {
  organization: "/app/companies",
  contact: "/app/contacts",
  deal: "/app/deals",
};

const KIND_GROUP_LABEL: Record<SearchHit["kind"], string> = {
  organization: "Companies",
  contact: "Contacts",
  deal: "Deals",
};

/**
 * ⌘K / Ctrl+K global command palette. Mounted once by AppShell so
 * the keybinding is available from every page. Jump-only for now —
 * Enter navigates to the selected hit's detail page. Keyboard nav:
 *   ↑/↓  move selection
 *   Enter navigate + close
 *   Esc  close
 *
 * Data comes from `/api/search?q=`. Fetches debounce at 150ms.
 * Palette stays empty until the user types at least 2 chars.
 */
export function CommandPalette() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<SearchHit[]>([]);
  const [cursor, setCursor] = useState(0);
  const [loading, setLoading] = useState(false);
  const inputRef = useRef<HTMLInputElement | null>(null);

  // Register the global keybinding.
  useEffect(() => {
    function onKey(e: globalThis.KeyboardEvent): void {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setOpen((v) => !v);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // Focus the input whenever the palette opens.
  useEffect(() => {
    if (open) {
      setCursor(0);
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }, [open]);

  // Debounced search as the user types.
  useEffect(() => {
    if (!open) return;
    if (query.trim().length < 2) {
      setHits([]);
      return;
    }
    let cancelled = false;
    setLoading(true);
    const timer = setTimeout(() => {
      fetch(`/api/search?q=${encodeURIComponent(query.trim())}&limit=6`)
        .then(async (res) => (res.ok ? res.json() : { hits: [] }))
        .then((body: { hits?: SearchHit[] }) => {
          if (cancelled) return;
          setHits(Array.isArray(body.hits) ? body.hits : []);
          setCursor(0);
        })
        .catch(() => {
          if (!cancelled) setHits([]);
        })
        .finally(() => {
          if (!cancelled) setLoading(false);
        });
    }, 150);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [query, open]);

  function close(): void {
    setOpen(false);
    setQuery("");
    setHits([]);
  }

  function jump(hit: SearchHit): void {
    router.push(`${KIND_ROUTE[hit.kind]}/${hit.id}`);
    close();
  }

  function onInputKey(e: KeyboardEvent<HTMLInputElement>): void {
    if (e.key === "Escape") {
      e.preventDefault();
      close();
      return;
    }
    if (hits.length === 0) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setCursor((c) => (c + 1) % hits.length);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setCursor((c) => (c - 1 + hits.length) % hits.length);
    } else if (e.key === "Enter") {
      e.preventDefault();
      const hit = hits[cursor];
      if (hit) jump(hit);
    }
  }

  if (!open) return null;

  // Group hits by kind so the list reads like Companies / Contacts / Deals.
  const groups: Array<{ kind: SearchHit["kind"]; hits: SearchHit[] }> = [];
  for (const kind of ["organization", "contact", "deal"] as const) {
    const groupHits = hits.filter((h) => h.kind === kind);
    if (groupHits.length > 0) groups.push({ kind, hits: groupHits });
  }

  // Flat cursor index → which hit. The `cursor` state indexes into
  // the flat `hits` list so keyboard nav matches the rendered order.
  let flatIdx = -1;

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/70 px-4 pt-28 backdrop-blur-md"
      onClick={close}
      role="presentation"
    >
      <div
        className="w-full max-w-xl overflow-hidden rounded-xl border border-line-strong bg-surface-2/95 shadow-overlay backdrop-blur-xl"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-label="Search companies, contacts, and deals"
        aria-modal="true"
      >
        <div className="flex items-center gap-2 border-b border-line-soft px-3.5 py-3">
          <svg
            aria-hidden="true"
            className="h-4 w-4 flex-shrink-0 text-text-muted"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <circle cx="11" cy="11" r="7" />
            <path d="M21 21l-4.35-4.35" />
          </svg>
          <input
            ref={inputRef}
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onInputKey}
            placeholder="Jump to a company, contact, or deal…"
            className="w-full bg-transparent text-sm text-text-primary placeholder:text-text-muted focus:outline-none"
            aria-label="Search query"
          />
          <kbd className="num-mono hidden rounded border border-line-soft bg-surface-1 px-1.5 py-0.5 text-[10px] text-text-muted sm:inline-flex">
            esc
          </kbd>
        </div>

        <div className="max-h-80 overflow-y-auto p-2">
          {query.trim().length < 2 ? (
            <p className="px-2 py-3 text-xs text-text-muted">
              Type at least 2 characters.{" "}
              <span className="text-text-secondary">↑↓</span> to move,{" "}
              <span className="text-text-secondary">Enter</span> to jump,{" "}
              <span className="text-text-secondary">Esc</span> to close.
            </p>
          ) : loading && hits.length === 0 ? (
            <p className="px-2 py-3 text-xs text-text-muted">Searching…</p>
          ) : hits.length === 0 ? (
            <p className="px-2 py-3 text-xs text-text-muted">
              No matches for &ldquo;{query.trim()}&rdquo;.
            </p>
          ) : (
            groups.map((group) => (
              <div key={group.kind} className="mb-2 last:mb-0">
                <div className="px-2 pb-1 pt-1 text-eyebrow text-text-muted">
                  {KIND_GROUP_LABEL[group.kind]}
                </div>
                <ul>
                  {group.hits.map((hit) => {
                    flatIdx += 1;
                    const selected = flatIdx === cursor;
                    return (
                      <li key={hit.id}>
                        <button
                          type="button"
                          onClick={() => jump(hit)}
                          onMouseEnter={() =>
                            setCursor(hits.indexOf(hit))
                          }
                          className={`flex w-full items-center justify-between gap-3 rounded-md px-2.5 py-2 text-left text-sm transition-colors ${
                            selected
                              ? "bg-accent-soft text-text-primary"
                              : "text-text-primary/90 hover:bg-white/[0.04]"
                          }`}
                        >
                          <span className="truncate">{hit.label}</span>
                          {hit.sublabel && (
                            <span className="flex-shrink-0 text-xs text-text-muted">
                              {hit.sublabel}
                            </span>
                          )}
                        </button>
                      </li>
                    );
                  })}
                </ul>
              </div>
            ))
          )}
        </div>

        <div className="flex items-center justify-between border-t border-line-soft bg-surface-1/50 px-3 py-2 text-[10px] text-text-muted">
          <span>↑↓ navigate · Enter jump · Esc close</span>
          <kbd className="num-mono rounded border border-line-soft bg-surface-1 px-1.5 py-0.5 font-medium">
            ⌘K
          </kbd>
        </div>
      </div>
    </div>
  );
}
