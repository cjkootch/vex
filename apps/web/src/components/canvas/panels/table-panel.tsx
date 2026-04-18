"use client";

import { useCallback, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
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

// Canonical fuel-deal ref pattern (VTC-YYYY-NNN). When the table
// contains a column whose header matches "deal ref" (case-insensitive)
// AND that cell matches this pattern, the row becomes a clickable link
// to the full deal view.
const DEAL_REF_RE = /^VTC-\d{4}-\d{3}$/;

export function TablePanel({ title, columns, rows }: TableProps) {
  const router = useRouter();
  const data = useMemo(() => rows.slice(0, MAX_ROWS), [rows]);
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
        cell: ({ getValue }) => String(getValue() ?? ""),
      })),
    [columns],
  );

  // Click → lookup dealRef → push. Keeping the resolution in the
  // panel (rather than e.g. a by-ref route) is one click + one API
  // call and avoids a flash of the landing-on-a-redirector page.
  const openDeal = useCallback(
    async (dealRef: string): Promise<void> => {
      if (!DEAL_REF_RE.test(dealRef)) return;
      try {
        const res = await fetch("/api/deals", {
          credentials: "include",
          cache: "no-store",
        });
        if (!res.ok) return;
        const data = (await res.json()) as {
          deals?: Array<{ id?: string; dealRef?: string }>;
        };
        const deal = data.deals?.find((d) => d.dealRef === dealRef);
        if (deal?.id) {
          router.push(`/app/deals/${deal.id}`);
        }
      } catch {
        // Silent fail — user stays on chat, nothing destructive.
      }
    },
    [router],
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
                {table.getRowModel().rows.map((row) => {
                  const dealRef = dealRefColumn
                    ? row.original[dealRefColumn]
                    : undefined;
                  const clickable =
                    typeof dealRef === "string" && DEAL_REF_RE.test(dealRef);
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
