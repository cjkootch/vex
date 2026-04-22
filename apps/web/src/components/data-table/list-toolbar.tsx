"use client";

import type { ReactNode } from "react";

/**
 * Filter bar for list pages — one row that holds the search input,
 * any number of facet chip groups, and a right-aligned row-count pill.
 * Pages compose FacetChips + search + extra slots here instead of each
 * page re-inventing its own filter layout.
 */
export function ListToolbar({
  search,
  onSearchChange,
  searchPlaceholder = "Filter…",
  facets,
  rightSlot,
  count,
  countLabel,
}: {
  search: string;
  onSearchChange: (next: string) => void;
  searchPlaceholder?: string;
  facets?: ReactNode;
  rightSlot?: ReactNode;
  count?: number;
  countLabel?: (n: number) => string;
}): React.ReactElement {
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
      <div className="relative min-w-[220px] flex-1 sm:max-w-sm">
        <svg
          aria-hidden="true"
          viewBox="0 0 24 24"
          className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-text-muted"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
        >
          <circle cx="11" cy="11" r="7" />
          <path strokeLinecap="round" d="M20 20l-3.5-3.5" />
        </svg>
        <input
          type="search"
          value={search}
          onChange={(e) => onSearchChange(e.target.value)}
          placeholder={searchPlaceholder}
          className="w-full rounded-md border border-line-soft bg-surface-2/60 pl-8 pr-3 py-1.5 text-sm text-text-primary placeholder:text-text-muted transition-colors focus:border-accent focus:outline-none"
        />
      </div>
      {facets}
      <div className="ml-auto flex items-center gap-2">
        {count !== undefined ? (
          <span className="num text-xs text-text-muted">
            {countLabel ? countLabel(count) : `${count} ${count === 1 ? "row" : "rows"}`}
          </span>
        ) : null}
        {rightSlot}
      </div>
    </div>
  );
}

/**
 * A pill-tab group for mutually-exclusive facet filters (Status, LOB,
 * Fit bucket). Pass `null`/"" as the value to render an "All" option.
 */
export function FacetChips<T extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label?: string;
  value: T;
  options: ReadonlyArray<{ label: string; value: T; count?: number }>;
  onChange: (next: T) => void;
}): React.ReactElement {
  return (
    <div className="flex items-center gap-1.5">
      {label ? (
        <span className="text-eyebrow text-text-muted">{label}</span>
      ) : null}
      <div className="flex items-center gap-1 rounded-md border border-line-soft bg-surface-2/40 p-0.5">
        {options.map((opt) => {
          const active = opt.value === value;
          return (
            <button
              key={opt.value || "__all"}
              type="button"
              onClick={() => onChange(opt.value)}
              className={`flex items-center gap-1 rounded px-2 py-0.5 text-xs transition-colors ${
                active
                  ? "bg-accent-soft/70 text-text-primary shadow-soft"
                  : "text-text-secondary hover:bg-surface-2/60 hover:text-text-primary"
              }`}
            >
              <span>{opt.label}</span>
              {opt.count !== undefined ? (
                <span
                  className={`num text-[10px] ${
                    active ? "text-text-primary/80" : "text-text-muted"
                  }`}
                >
                  {opt.count}
                </span>
              ) : null}
            </button>
          );
        })}
      </div>
    </div>
  );
}
