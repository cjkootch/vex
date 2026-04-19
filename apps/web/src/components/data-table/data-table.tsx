"use client";

import { useMemo, useState, type ReactNode } from "react";
import {
  flexRender,
  getCoreRowModel,
  getFilteredRowModel,
  getPaginationRowModel,
  getSortedRowModel,
  useReactTable,
  type ColumnDef,
  type SortingState,
} from "@tanstack/react-table";

/**
 * Shared CRM-style DataTable used by /app/deals, /app/companies, and
 * /app/contacts. Thin wrapper around @tanstack/react-table with our
 * dark-mode styling, a top-right search input, and a simple pager.
 *
 * Rows are plain objects; columns are TanStack ColumnDef entries so
 * each list surface can customise cell rendering (status pills,
 * object chips, etc.) without subclassing.
 */
export interface DataTableProps<T> {
  data: readonly T[];
  columns: ColumnDef<T, unknown>[];
  /** Filter placeholder — shown above the table. Defaults to "Filter…". */
  filterPlaceholder?: string;
  /**
   * Substring filter applied across every column's stringified value.
   * The table is always client-side filtered so the pager stays in sync.
   */
  initialFilter?: string;
  /** Rendered when `data.length === 0`. */
  emptyState?: ReactNode;
  /** Rows per page. Defaults to 25. */
  pageSize?: number;
  /** Called when a row is clicked (keyboard Enter also triggers). */
  onRowClick?: (row: T) => void;
  /**
   * Optional row-selection state, lifted to the parent so it can
   * render bulk-action UI (export selected, bulk tag, etc.). When
   * provided, the table renders a checkbox column as the first
   * column with a header "select-all" that toggles every row that
   * passes the current filter.
   */
  selectedIds?: Set<string>;
  onSelectionChange?: (next: Set<string>) => void;
  /** Extract the stable row id used as the selection key. Required when selection is enabled. */
  getRowId?: (row: T) => string;
}

export function DataTable<T>({
  data,
  columns,
  filterPlaceholder = "Filter…",
  initialFilter = "",
  emptyState,
  pageSize = 25,
  onRowClick,
  selectedIds,
  onSelectionChange,
  getRowId,
}: DataTableProps<T>) {
  const [sorting, setSorting] = useState<SortingState>([]);
  const [globalFilter, setGlobalFilter] = useState(initialFilter);

  const selectable = selectedIds !== undefined && onSelectionChange !== undefined && getRowId !== undefined;

  const memoColumns = useMemo(() => {
    if (!selectable) return columns;
    const checkboxColumn: ColumnDef<T, unknown> = {
      id: "__selection",
      header: () => null, // rendered manually so it can reference visible rows
      cell: () => null, // rendered manually per-row
      enableSorting: false,
      size: 36,
    };
    return [checkboxColumn, ...columns];
  }, [columns, selectable]);
  const memoData = useMemo(() => data as T[], [data]);

  const table = useReactTable({
    data: memoData,
    columns: memoColumns,
    state: { sorting, globalFilter },
    onSortingChange: setSorting,
    onGlobalFilterChange: setGlobalFilter,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    getFilteredRowModel: getFilteredRowModel(),
    getPaginationRowModel: getPaginationRowModel(),
    initialState: { pagination: { pageSize } },
  });

  const rows = table.getRowModel().rows;
  const page = table.getState().pagination.pageIndex + 1;
  const pageCount = table.getPageCount() || 1;
  const filteredCount = table.getFilteredRowModel().rows.length;

  // Derive select-all state across every filtered row (not just the
  // current page — users expect "select all" to honour the filter).
  const filteredRows = table.getFilteredRowModel().rows;
  const filteredIds = selectable
    ? filteredRows.map((r) => getRowId!(r.original))
    : [];
  const selectedOnPage =
    selectable && selectedIds
      ? filteredIds.filter((id) => selectedIds.has(id)).length
      : 0;
  const allSelected =
    selectable && filteredIds.length > 0 && selectedOnPage === filteredIds.length;
  const someSelected =
    selectable && selectedOnPage > 0 && !allSelected;

  function toggleAll(next: boolean): void {
    if (!selectable || !selectedIds || !onSelectionChange) return;
    const copy = new Set(selectedIds);
    if (next) {
      for (const id of filteredIds) copy.add(id);
    } else {
      for (const id of filteredIds) copy.delete(id);
    }
    onSelectionChange(copy);
  }

  function toggleOne(id: string, next: boolean): void {
    if (!selectable || !selectedIds || !onSelectionChange) return;
    const copy = new Set(selectedIds);
    if (next) copy.add(id);
    else copy.delete(id);
    onSelectionChange(copy);
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between">
        <input
          type="search"
          value={globalFilter}
          onChange={(e) => setGlobalFilter(e.target.value)}
          placeholder={filterPlaceholder}
          className="w-64 rounded-md border border-line bg-muted/40 px-3 py-1.5 text-sm text-white placeholder:text-white/40 focus:border-accent focus:outline-none"
        />
        <span className="text-xs text-white/50">
          {filteredCount} {filteredCount === 1 ? "row" : "rows"}
        </span>
      </div>

      <div className="overflow-hidden rounded-lg border border-line">
        <table className="min-w-full text-left text-sm">
          <thead className="bg-muted/40 text-xs uppercase tracking-wide text-white/60">
            {table.getHeaderGroups().map((headerGroup) => (
              <tr key={headerGroup.id}>
                {headerGroup.headers.map((header) => {
                  if (header.column.id === "__selection") {
                    return (
                      <th key={header.id} className="px-3 py-2 w-9">
                        <input
                          type="checkbox"
                          aria-label="Select all filtered rows"
                          checked={allSelected}
                          ref={(el) => {
                            if (el) el.indeterminate = someSelected;
                          }}
                          onChange={(e) => toggleAll(e.target.checked)}
                          onClick={(e) => e.stopPropagation()}
                          className="h-4 w-4 rounded border-line bg-canvas accent-accent"
                        />
                      </th>
                    );
                  }
                  const canSort = header.column.getCanSort();
                  const sort = header.column.getIsSorted();
                  return (
                    <th
                      key={header.id}
                      className="px-3 py-2 font-medium"
                      onClick={canSort ? header.column.getToggleSortingHandler() : undefined}
                      style={canSort ? { cursor: "pointer", userSelect: "none" } : undefined}
                    >
                      <span className="inline-flex items-center gap-1">
                        {flexRender(header.column.columnDef.header, header.getContext())}
                        {sort === "asc" && <span aria-hidden>↑</span>}
                        {sort === "desc" && <span aria-hidden>↓</span>}
                      </span>
                    </th>
                  );
                })}
              </tr>
            ))}
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr>
                <td
                  colSpan={table.getAllLeafColumns().length}
                  className="px-3 py-8 text-center text-sm text-white/50"
                >
                  {emptyState ?? "No rows match the current filter."}
                </td>
              </tr>
            ) : (
              rows.map((row) => (
                <tr
                  key={row.id}
                  onClick={onRowClick ? () => onRowClick(row.original) : undefined}
                  onKeyDown={
                    onRowClick
                      ? (e) => {
                          if (e.key === "Enter") onRowClick(row.original);
                        }
                      : undefined
                  }
                  tabIndex={onRowClick ? 0 : undefined}
                  className={`border-t border-line transition-colors hover:bg-muted/30 ${
                    onRowClick ? "cursor-pointer" : ""
                  }`}
                >
                  {row.getVisibleCells().map((cell) => {
                    if (cell.column.id === "__selection") {
                      const id = getRowId!(row.original);
                      const checked = selectedIds?.has(id) ?? false;
                      return (
                        <td key={cell.id} className="px-3 py-2 w-9 align-middle">
                          <input
                            type="checkbox"
                            aria-label={`Select row ${id}`}
                            checked={checked}
                            onChange={(e) => toggleOne(id, e.target.checked)}
                            onClick={(e) => e.stopPropagation()}
                            className="h-4 w-4 rounded border-line bg-canvas accent-accent"
                          />
                        </td>
                      );
                    }
                    return (
                      <td key={cell.id} className="px-3 py-2 align-middle text-white/90">
                        {flexRender(cell.column.columnDef.cell, cell.getContext())}
                      </td>
                    );
                  })}
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      {pageCount > 1 && (
        <div className="flex items-center justify-end gap-2 text-xs text-white/60">
          <button
            type="button"
            onClick={() => table.previousPage()}
            disabled={!table.getCanPreviousPage()}
            className="rounded border border-line px-2 py-1 disabled:opacity-30"
          >
            Prev
          </button>
          <span>
            Page {page} of {pageCount}
          </span>
          <button
            type="button"
            onClick={() => table.nextPage()}
            disabled={!table.getCanNextPage()}
            className="rounded border border-line px-2 py-1 disabled:opacity-30"
          >
            Next
          </button>
        </div>
      )}
    </div>
  );
}
