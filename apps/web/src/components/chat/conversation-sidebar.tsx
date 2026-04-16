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
}

export function ConversationSidebar({ items, activeId, onSelect, onNew }: Props) {
  const [filter, setFilter] = useState("");
  const visible = useMemo(() => {
    const q = filter.trim().toLowerCase();
    if (!q) return items;
    return items.filter((c) => c.title.toLowerCase().includes(q));
  }, [items, filter]);

  return (
    <aside className="flex h-full w-60 flex-none flex-col border-r border-line bg-canvas/60">
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
          <li key={c.id}>
            <button
              type="button"
              onClick={() => onSelect(c.id)}
              className={`block w-full truncate px-3 py-2 text-left text-sm ${
                c.id === activeId
                  ? "bg-accent/20 text-white"
                  : "text-white/70 hover:bg-white/5"
              }`}
            >
              {c.title}
            </button>
          </li>
        ))}
      </ul>
    </aside>
  );
}
