"use client";

import { useMemo, useState } from "react";
import {
  flexRender,
  getCoreRowModel,
  getPaginationRowModel,
  getSortedRowModel,
  useReactTable,
  type ColumnDef,
  type SortingState,
} from "@tanstack/react-table";
import type { ManifestPanel } from "@vex/ui";

type TableProps = Extract<ManifestPanel, { type: "table" }>;

const PAGE_SIZE = 25;
const MAX_ROWS = 100;

export function TablePanel({ title, columns, rows }: TableProps) {
  const data = useMemo(() => rows.slice(0, MAX_ROWS), [rows]);
  const colDefs = useMemo<ColumnDef<Record<string, string>>[]>(
    () =>
      columns.map((c) => ({
        id: c,
        accessorKey: c,
        header: c,
        cell: ({ getValue }) => String(getValue() ?? ""),
      })),
    [columns],
  );

  const [sorting, setSorting] = useState<SortingState>([]);
  const table = useReactTable({
    data,
    columns: colDefs,
    state: { sorting },
    onSortingChange: setSorting,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    getPaginationRowModel: getPaginationRowModel(),
    initialState: { pagination: { pageSize: PAGE_SIZE } },
  });

  return (
    <section
      data-panel="table"
      className="overflow-hidden rounded-lg border border-line bg-muted/40"
    >
      <header className="border-b border-line px-4 py-3">
        <h3 className="text-sm font-semibold text-white">{title}</h3>
        {rows.length > MAX_ROWS && (
          <p className="text-xs text-white/40">
            Showing first {MAX_ROWS} of {rows.length} rows
          </p>
        )}
      </header>

      {data.length === 0 ? (
        <div className="px-4 py-8 text-center text-sm text-white/50">No results</div>
      ) : (
        <>
          <div className="max-h-[480px] overflow-auto">
            <table className="w-full text-sm">
              <thead className="border-b border-line text-xs uppercase tracking-wider text-white/40">
                {table.getHeaderGroups().map((hg) => (
                  <tr key={hg.id}>
                    {hg.headers.map((h) => (
                      <th
                        key={h.id}
                        onClick={h.column.getToggleSortingHandler()}
                        className="cursor-pointer select-none px-3 py-2 text-left hover:text-white"
                      >
                        {flexRender(h.column.columnDef.header, h.getContext())}
                        {{ asc: " ↑", desc: " ↓" }[h.column.getIsSorted() as string] ?? ""}
                      </th>
                    ))}
                  </tr>
                ))}
              </thead>
              <tbody>
                {table.getRowModel().rows.map((row) => (
                  <tr key={row.id} className="border-b border-line/40 hover:bg-white/5">
                    {row.getVisibleCells().map((cell) => (
                      <td key={cell.id} className="px-3 py-2 text-white/90">
                        {flexRender(cell.column.columnDef.cell, cell.getContext())}
                      </td>
                    ))}
                  </tr>
                ))}
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
