"use client";

import { useMemo, useState } from "react";

export interface ConversationListItem {
  id: string;
  title: string;
  updatedAt: number;
}

interface Props {
  items: ConversationListItem[];
  activeId: string | null;
  onSelect: (id: string) => void;
  onNew: () => void;
  /** Remove a conversation from the list. Caller persists. */
  onDelete?: (id: string) => void;
}

export function ConversationSidebar({
  items,
  activeId,
  onSelect,
  onNew,
  onDelete,
}: Props) {
  const [filter, setFilter] = useState("");
  const visible = useMemo(() => {
    const q = filter.trim().toLowerCase();
    if (!q) return items;
    return items.filter((c) => c.title.toLowerCase().includes(q));
  }, [items, filter]);

  return (
    <aside className="hidden h-full w-60 flex-none flex-col border-r border-line bg-canvas/60 md:flex">
      <div className="border-b border-line p-3">
        <button
          type="button"
          onClick={onNew}
          data-testid="new-conversation"
          className="w-full rounded-md bg-accent px-3 py-2 text-sm font-medium text-white"
        >
          + New chat
        </button>
        <input
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="Search…"
          aria-label="Search conversations"
          className="mt-3 w-full rounded-md border border-line bg-muted/60 px-2 py-1 text-sm text-white placeholder:text-white/40 outline-none focus:border-accent"
        />
      </div>
      <ul className="flex-1 overflow-y-auto">
        {visible.length === 0 && (
          <li className="px-3 py-4 text-xs text-white/40">No conversations.</li>
        )}
        {visible.map((c) => (
          <li key={c.id} className="group relative">
            <button
              type="button"
              onClick={() => onSelect(c.id)}
              className={`block w-full truncate px-3 py-2 pr-8 text-left text-sm ${
                c.id === activeId
                  ? "bg-accent/20 text-white"
                  : "text-white/70 hover:bg-white/5"
              }`}
            >
              {c.title}
            </button>
            {onDelete ? (
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  onDelete(c.id);
                }}
                aria-label={`Delete conversation "${c.title}"`}
                className="absolute right-1 top-1/2 hidden -translate-y-1/2 rounded p-1 text-white/40 hover:bg-white/10 hover:text-bad group-hover:block focus-visible:block"
              >
                <svg
                  xmlns="http://www.w3.org/2000/svg"
                  viewBox="0 0 20 20"
                  fill="currentColor"
                  aria-hidden="true"
                  className="h-3.5 w-3.5"
                >
                  <path
                    fillRule="evenodd"
                    d="M8.75 1a.75.75 0 0 0-.75.75V3H4.5a.75.75 0 0 0 0 1.5h11a.75.75 0 0 0 0-1.5H12V1.75a.75.75 0 0 0-.75-.75h-2.5ZM5.5 6.5a.75.75 0 0 1 .75.75v9a.25.25 0 0 0 .25.25h7a.25.25 0 0 0 .25-.25v-9a.75.75 0 0 1 1.5 0v9a1.75 1.75 0 0 1-1.75 1.75h-7A1.75 1.75 0 0 1 4.75 16.25v-9a.75.75 0 0 1 .75-.75Z"
                    clipRule="evenodd"
                  />
                </svg>
              </button>
            ) : null}
          </li>
        ))}
      </ul>
    </aside>
  );
}
