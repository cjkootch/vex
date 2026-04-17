"use client";

import type { ReactNode } from "react";

export interface TabDefinition {
  id: string;
  label: string;
  /** Optional count shown as a chip next to the label. */
  count?: number;
  content: ReactNode;
}

export interface TabsProps {
  tabs: TabDefinition[];
  active: string;
  onChange: (id: string) => void;
}

/**
 * Lightweight tab bar for detail pages. Controlled-only (the parent
 * owns `active`) so tab state can be lifted into a URL query param
 * later without touching the component.
 */
export function Tabs({ tabs, active, onChange }: TabsProps) {
  const activeTab = tabs.find((t) => t.id === active) ?? tabs[0];
  return (
    <div className="flex flex-col gap-4">
      <div
        role="tablist"
        aria-label="Detail sections"
        className="flex gap-1 border-b border-line"
      >
        {tabs.map((tab) => {
          const selected = tab.id === activeTab?.id;
          return (
            <button
              key={tab.id}
              type="button"
              role="tab"
              aria-selected={selected}
              onClick={() => onChange(tab.id)}
              className={`-mb-px border-b-2 px-3 py-2 text-sm transition-colors ${
                selected
                  ? "border-accent text-white"
                  : "border-transparent text-white/60 hover:text-white/90"
              }`}
            >
              <span>{tab.label}</span>
              {typeof tab.count === "number" && (
                <span
                  className={`ml-1 rounded-full px-1.5 py-0.5 text-[10px] ${
                    selected
                      ? "bg-accent/30 text-accent"
                      : "bg-muted/60 text-white/60"
                  }`}
                >
                  {tab.count}
                </span>
              )}
            </button>
          );
        })}
      </div>

      <div role="tabpanel" aria-labelledby={activeTab?.id}>
        {activeTab?.content}
      </div>
    </div>
  );
}
