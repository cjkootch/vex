"use client";

import { useCallback, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import {
  flexRender,
  getCoreRowModel,
  getFilteredRowModel,
  getPaginationRowModel,
  getSortedRowModel,
  useReactTable,
  type ColumnDef,
  type ColumnFiltersState,
  type SortingState,
} from "@tanstack/react-table";
import type { ManifestPanel } from "@vex/ui";

type Props = Extract<ManifestPanel, { type: "filterable_table" }>;

const PAGE_SIZE = 25;
const MAX_ROWS = 500;
const DEAL_REF_RE = /^VTC-\d{4}-\d{3}$/;
const NUMERIC_RE = /^-?\$?[\d,]+(\.\d+)?%?$/;

function toneClass(tone: "good" | "warn" | "bad" | "neutral"): string {
  switch (tone) {
    case "good":
      return "text-good";
    case "warn":
      return "text-warn";
    case "bad":
      return "text-bad";
    case "neutral":
      return "text-white/70";
  }
}

function toComparable(raw: unknown): number | string {
  if (typeof raw !== "string") return String(raw ?? "");
  if (NUMERIC_RE.test(raw)) {
    const cleaned = raw.replace(/[$,%]/g, "");
    const n = Number.parseFloat(cleaned);
    if (Number.isFinite(n)) return n;
  }
  return raw.toLowerCase();
}

export function FilterableTablePanel({
  title,
  columns,
  rows,
  filterableColumns,
  sortableColumns,
  defaultSort,
  tone,
}: Props) {
  const router = useRouter();
  const data = useMemo(() => rows.slice(0, MAX_ROWS), [rows]);
  const colSet = useMemo(() => new Set(columns), [columns]);
  const filterables = useMemo(
    () => filterableColumns.filter((c) => colSet.has(c)),
    [filterableColumns, colSet],
  );
  const sortables = useMemo(
    () => new Set(sortableColumns.filter((c) => colSet.has(c))),
    [sortableColumns, colSet],
  );
  const dealRefColumn = useMemo(
    () => columns.find((c) => /deal.?ref/i.test(c)) ?? null,
    [columns],
  );

  const colDefs = useMemo<ColumnDef<Record<string, string>>[]>(
    () =>
      columns.map((c) => ({
        id: c,
        accessorKey: c,
        header: c,
        enableSorting: sortables.has(c),
        enableColumnFilter: filterables.includes(c),
        // Filter: case-insensitive substring match against the cell.
        filterFn: (row, colId, value) => {
          if (!value) return true;
          const v = String(row.getValue(colId) ?? "").toLowerCase();
          return v.includes(String(value).toLowerCase());
        },
        // Sort: numeric when both values parse as numbers, else lex.
        sortingFn: (a, b, colId) => {
          const av = toComparable(a.getValue(colId));
          const bv = toComparable(b.getValue(colId));
          if (typeof av === "number" && typeof bv === "number") return av - bv;
          return String(av).localeCompare(String(bv));
        },
        cell: ({ getValue, row }) => {
          const value = String(getValue() ?? "");
          const t = tone?.[c]?.[value];
          const rowDealRef = dealRefColumn ? row.original[dealRefColumn] : undefined;
          return (
            <span
              className={
                t
                  ? toneClass(t)
                  : rowDealRef && c === dealRefColumn
                    ? "text-accent"
                    : ""
              }
            >
              {value}
            </span>
          );
        },
      })),
    [columns, dealRefColumn, filterables, sortables, tone],
  );

  const openDeal = useCallback(
    async (dealRef: string): Promise<void> => {
      if (!DEAL_REF_RE.test(dealRef)) return;
      try {
        const res = await fetch("/api/deals?limit=500", {
          credentials: "include",
          cache: "no-store",
        });
        if (!res.ok) return;
        const body = (await res.json()) as {
          deals?: Array<{ id?: string; dealRef?: string }>;
        };
        const deal = body.deals?.find((d) => d.dealRef === dealRef);
        if (deal?.id) router.push(`/app/deals/${deal.id}`);
      } catch {
        /* silent */
      }
    },
    [router],
  );

  const initialSorting: SortingState = defaultSort
    ? [{ id: defaultSort.column, desc: defaultSort.direction === "desc" }]
    : [];
  const [sorting, setSorting] = useState<SortingState>(initialSorting);
  const [columnFilters, setColumnFilters] = useState<ColumnFiltersState>([]);

  const table = useReactTable({
    data,
    columns: colDefs,
    state: { sorting, columnFilters },
    onSortingChange: setSorting,
    onColumnFiltersChange: setColumnFilters,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    getFilteredRowModel: getFilteredRowModel(),
    getPaginationRowModel: getPaginationRowModel(),
    initialState: { pagination: { pageSize: PAGE_SIZE } },
  });

  const totalVisible = table.getFilteredRowModel().rows.length;
  const anyFilterActive = columnFilters.length > 0;

  return (
    <section
      data-panel="filterable_table"
      className="overflow-hidden rounded-lg border border-line bg-muted/40"
    >
      <header className="flex flex-col gap-2 border-b border-line px-4 py-3">
        <div className="flex items-baseline justify-between gap-3">
          <h3 className="text-sm font-semibold text-white">{title}</h3>
          <span className="text-xs text-white/40">
            {anyFilterActive
              ? `${totalVisible} of ${data.length} rows`
              : `${data.length} rows${rows.length > MAX_ROWS ? ` (of ${rows.length})` : ""}`}
          </span>
        </div>
        {filterables.length > 0 && (
          <div className="flex flex-wrap gap-2">
            {filterables.map((colId) => {
              const col = table.getColumn(colId);
              if (!col) return null;
              const current = (col.getFilterValue() as string | undefined) ?? "";
              return (
                <label key={colId} className="flex items-center gap-1.5 text-xs text-white/50">
                  <span>{colId}</span>
                  <input
                    type="text"
                    value={current}
                    onChange={(e) => col.setFilterValue(e.target.value || undefined)}
                    placeholder="filter…"
                    className="w-32 rounded border border-line bg-canvas px-2 py-1 text-white/80 placeholder:text-white/30 focus:border-accent focus:outline-none"
                    data-testid={`filter-${colId}`}
                  />
                </label>
              );
            })}
            {anyFilterActive && (
              <button
                type="button"
                onClick={() => setColumnFilters([])}
                className="text-xs text-white/40 underline hover:text-white/80"
                data-testid="filter-clear"
              >
                clear
              </button>
            )}
          </div>
        )}
      </header>

      {totalVisible === 0 ? (
        <div className="px-4 py-8 text-center text-sm text-white/50">
          {anyFilterActive ? "No rows match these filters." : "No results"}
        </div>
      ) : (
        <>
          <div className="max-h-[560px] overflow-auto">
            <table className="w-full text-sm">
              <thead className="border-b border-line bg-canvas/40 text-xs uppercase tracking-wider text-white/40">
                {table.getHeaderGroups().map((hg) => (
                  <tr key={hg.id}>
                    {hg.headers.map((h) => {
                      const canSort = h.column.getCanSort();
                      return (
                        <th
                          key={h.id}
                          onClick={canSort ? h.column.getToggleSortingHandler() : undefined}
                          className={`px-3 py-2 text-left ${
                            canSort ? "cursor-pointer select-none hover:text-white" : ""
                          }`}
                        >
                          {flexRender(h.column.columnDef.header, h.getContext())}
                          {canSort
                            ? ({ asc: " ↑", desc: " ↓" }[h.column.getIsSorted() as string] ?? " ⇅")
                            : ""}
                        </th>
                      );
                    })}
                  </tr>
                ))}
              </thead>
              <tbody>
                {table.getRowModel().rows.map((row) => {
                  const dealRef = dealRefColumn ? row.original[dealRefColumn] : undefined;
                  const clickable = typeof dealRef === "string" && DEAL_REF_RE.test(dealRef);
                  return (
                    <tr
                      key={row.id}
                      {...(clickable
                        ? {
                            role: "link",
                            tabIndex: 0,
                            onClick: () => openDeal(dealRef!),
                            onKeyDown: (e) => {
                              if (e.key === "Enter" || e.key === " ") {
                                e.preventDefault();
                                openDeal(dealRef!);
                              }
                            },
                          }
                        : {})}
                      className={`border-b border-line/40 hover:bg-white/5 ${
                        clickable
                          ? "cursor-pointer focus-visible:outline focus-visible:outline-1 focus-visible:outline-accent"
                          : ""
                      }`}
                    >
                      {row.getVisibleCells().map((cell) => (
                        <td key={cell.id} className="px-3 py-2 text-white/90">
                          {flexRender(cell.column.columnDef.cell, cell.getContext())}
                        </td>
                      ))}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          {table.getPageCount() > 1 && (
            <div className="flex items-center justify-between border-t border-line px-4 py-2 text-xs text-white/60">
              <span>
                Page {table.getState().pagination.pageIndex + 1} of {table.getPageCount()}
              </span>
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={() => table.previousPage()}
                  disabled={!table.getCanPreviousPage()}
                  className="rounded border border-line px-2 py-1 disabled:opacity-30"
                >
                  Prev
                </button>
                <button
                  type="button"
                  onClick={() => table.nextPage()}
                  disabled={!table.getCanNextPage()}
                  className="rounded border border-line px-2 py-1 disabled:opacity-30"
                >
                  Next
                </button>
              </div>
            </div>
          )}
        </>
      )}
    </section>
  );
}
