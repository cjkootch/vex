"use client";

import Link from "next/link";

export interface QuickActionItem {
  label: string;
  /** Prompt text to pre-fill in chat. Trailing `: ` is fine — the user completes. */
  ask: string;
}

/**
 * Row of deep-link chips that jump into /app/chat with a prefilled
 * question. Cuts the "switch tab → type command → reference deal
 * ref" friction on every detail page.
 */
export function QuickActions({
  items,
}: {
  items: QuickActionItem[];
}): React.ReactElement {
  return (
    <div className="-mx-6 overflow-x-auto px-6 md:mx-0 md:px-0">
      <div className="flex gap-2 whitespace-nowrap">
        {items.map((item) => (
          <Link
            key={item.label}
            href={`/app/chat?ask=${encodeURIComponent(item.ask)}`}
            className="inline-flex items-center rounded-full border border-line bg-muted/40 px-3 py-1 text-xs text-white/80 transition hover:border-accent hover:text-white"
          >
            {item.label}
          </Link>
        ))}
      </div>
    </div>
  );
}
