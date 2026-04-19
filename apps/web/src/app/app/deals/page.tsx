"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { type ColumnDef } from "@tanstack/react-table";
import { DataTable } from "@/components/data-table/data-table";
import { NewDealForm } from "@/components/crm/new-deal-form";
import { DealStatusMenu } from "@/components/crm/deal-status-menu";
import { fetchWithRetry } from "@/lib/fetch-with-retry";
import { downloadCsv, toCsv } from "@/lib/csv";

interface DealRow {
  id: string;
  dealRef: string;
  status: string;
  product: string;
  buyerOrgId: string;
  buyerName: string | null;
  volumeUsg: number;
  incoterm: string;
  laycanStart: string | null;
  laycanEnd: string | null;
  complianceHold: boolean;
  ofacStatus: string;
  createdAt: string;
  updatedAt: string;
}

const STATUS_FILTERS = [
  { label: "All", value: "" },
  { label: "Draft", value: "draft" },
  { label: "Negotiating", value: "negotiating" },
  { label: "Approved", value: "approved" },
  { label: "In Transit", value: "in_transit" },
  { label: "Delivered", value: "delivered" },
  { label: "Settled", value: "settled" },
  { label: "Cancelled", value: "cancelled" },
] as const;

const PRODUCT_LABELS: Record<string, string> = {
  ulsd: "ULSD",
  jet_a1: "Jet A1",
  gasoline: "Gasoline",
  marine_gasoil: "Marine Gasoil",
  hsfo: "HSFO",
  vlsfo: "VLSFO",
};

export default function DealsPage() {
  const [deals, setDeals] = useState<DealRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState<string>("");
  const [creating, setCreating] = useState(false);
  const [toast, setToast] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const qs = statusFilter ? `?status=${encodeURIComponent(statusFilter)}` : "";
    fetchWithRetry(`/api/deals${qs}`, {
      onWaking: () => {
        if (!cancelled) setError("API is waking up…");
      },
    })
      .then(async (res) => {
        if (res.status === 404) {
          throw new Error(
            "apps/api doesn't have /deals yet — redeploy it on Fly.",
          );
        }
        if (res.status === 502 || res.status === 503) {
          throw new Error("API is still waking up. Try again in a moment.");
        }
        if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
        return res.json();
      })
      .then((body: unknown) => {
        if (cancelled) return;
        const rows =
          typeof body === "object" && body !== null &&
          Array.isArray((body as { deals?: unknown }).deals)
            ? ((body as { deals: DealRow[] }).deals)
            : null;
        if (rows === null) {
          setDeals([]);
          setError("apps/api returned an unexpected payload.");
          return;
        }
        setDeals(rows);
        setError(null);
      })
      .catch((err: Error) => {
        if (!cancelled) {
          setError(err.message);
          setDeals([]);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [statusFilter]);

  const columns = useMemo<ColumnDef<DealRow, unknown>[]>(
    () => [
      {
        accessorKey: "dealRef",
        header: "Deal",
        cell: ({ row }) => (
          <Link
            href={`/app/deals/${row.original.id}`}
            className="font-mono text-accent hover:underline"
            onClick={(e) => e.stopPropagation()}
          >
            {row.original.dealRef}
          </Link>
        ),
      },
      {
        accessorKey: "product",
        header: "Product",
        cell: ({ getValue }) => PRODUCT_LABELS[getValue<string>()] ?? getValue<string>(),
      },
      {
        accessorKey: "buyerName",
        header: "Buyer",
        cell: ({ row }) => (
          <Link
            href={`/app/companies/${row.original.buyerOrgId}`}
            onClick={(e) => e.stopPropagation()}
            className="text-white/90 hover:text-accent hover:underline"
          >
            {row.original.buyerName ?? row.original.buyerOrgId}
          </Link>
        ),
      },
      {
        accessorKey: "status",
        header: "Status",
        cell: ({ row }) => (
          <div className="flex items-center gap-2">
            <StatusPill status={row.original.status} />
            <DealStatusMenu
              dealId={row.original.id}
              dealRef={row.original.dealRef}
              currentStatus={row.original.status}
              onChanged={() => {
                setDeals(null);
                setStatusFilter("");
                setToast(`Status updated on ${row.original.dealRef}`);
              }}
              onApprovalRequested={(approvalId) => {
                setToast(
                  `Approval requested for ${row.original.dealRef} — see /app/approvals (${approvalId.slice(-6)})`,
                );
              }}
            />
          </div>
        ),
      },
      {
        accessorKey: "volumeUsg",
        header: "Volume",
        cell: ({ getValue }) => formatVolume(getValue<number>()),
      },
      {
        accessorKey: "incoterm",
        header: "Incoterm",
        cell: ({ getValue }) => getValue<string>().toUpperCase(),
      },
      {
        accessorKey: "laycanStart",
        header: "Laycan",
        cell: ({ row }) => formatLaycan(row.original.laycanStart, row.original.laycanEnd),
      },
      {
        id: "flags",
        header: "Flags",
        cell: ({ row }) => (
          <div className="flex gap-1">
            {row.original.complianceHold && (
              <span className="rounded bg-bad/20 px-1.5 py-0.5 text-xs text-bad">
                compliance hold
              </span>
            )}
            {row.original.ofacStatus !== "cleared" && (
              <span className="rounded bg-muted/60 px-1.5 py-0.5 text-xs text-white/70">
                ofac: {row.original.ofacStatus.replace("_", " ")}
              </span>
            )}
          </div>
        ),
      },
    ],
    [],
  );

  return (
    <div className="mx-auto flex h-full max-w-6xl flex-col gap-4 px-4 py-4 md:px-6 md:py-6">
      <header className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h1 className="text-xl font-semibold text-white">Deals</h1>
          <p className="mt-1 hidden text-sm text-white/60 md:block">
            Fuel deals, sortable and filterable. Click a row to open the deal detail.
          </p>
        </div>
        <div className="flex flex-shrink-0 items-center gap-2">
          <button
            type="button"
            disabled={!deals || deals.length === 0}
            onClick={() => {
              if (!deals) return;
              const csv = toCsv(
                [
                  "deal_ref",
                  "status",
                  "product",
                  "volume_usg",
                  "incoterm",
                  "buyer",
                  "laycan_start",
                  "laycan_end",
                  "compliance_hold",
                  "ofac_status",
                  "created_at",
                  "updated_at",
                ],
                deals.map((d) => [
                  d.dealRef,
                  d.status,
                  d.product,
                  d.volumeUsg,
                  d.incoterm,
                  d.buyerName ?? d.buyerOrgId,
                  d.laycanStart ?? "",
                  d.laycanEnd ?? "",
                  d.complianceHold,
                  d.ofacStatus,
                  d.createdAt,
                  d.updatedAt,
                ]),
              );
              downloadCsv(
                `deals-${new Date().toISOString().slice(0, 10)}.csv`,
                csv,
              );
            }}
            className="inline-flex h-9 items-center rounded-md border border-line bg-muted/40 px-3 text-sm text-white/80 hover:bg-muted/60 disabled:opacity-40"
          >
            CSV
          </button>
          <Link
            href="/app/chat?ask=Show%20me%20all%20deals%20with%20compliance%20holds"
            aria-label="Ask Vex about deals"
            className="inline-flex h-9 items-center justify-center rounded-md border border-line px-3 text-sm text-white/80 hover:border-accent hover:text-white"
          >
            {/* Icon-only below sm to save the width for the primary CTA. */}
            <span className="hidden sm:inline">Ask Vex →</span>
            <span className="sm:hidden" aria-hidden="true">
              ✦
            </span>
          </Link>
          <button
            type="button"
            onClick={() => setCreating(true)}
            className="inline-flex h-9 items-center rounded-md bg-accent px-3 text-sm font-medium text-white hover:bg-accent/90"
          >
            + New deal
          </button>
        </div>
      </header>

      <NewDealForm
        open={creating}
        onClose={() => setCreating(false)}
        onCreated={() => {
          // Refetch so the new row shows up with server-enriched buyer
          // name and updated timestamps.
          setDeals(null);
          setStatusFilter("");
        }}
      />

      {/*
        Filter chips. On mobile we let them scroll horizontally so the
        row never wraps — wrapping chips double the header chrome on a
        phone. On md+ they wrap naturally as before.
      */}
      <div className="-mx-4 overflow-x-auto px-4 md:mx-0 md:px-0">
        <div className="flex gap-1 whitespace-nowrap md:flex-wrap">
          {STATUS_FILTERS.map((s) => (
            <button
              key={s.value}
              type="button"
              onClick={() => setStatusFilter(s.value)}
              className={`rounded-md px-3 py-1.5 text-xs transition-colors ${
                statusFilter === s.value
                  ? "bg-accent text-white"
                  : "bg-muted/40 text-white/70 hover:bg-muted/60"
              }`}
            >
              {s.label}
            </button>
          ))}
        </div>
      </div>

      {error && (
        <div className="rounded-md border border-bad/40 bg-bad/10 px-3 py-2 text-sm text-bad">
          Couldn&apos;t load deals: {error}
        </div>
      )}

      {toast && (
        <div
          className="flex items-center justify-between rounded-md border border-good/40 bg-good/10 px-3 py-2 text-sm text-good"
          role="status"
        >
          <span>{toast}</span>
          <button
            type="button"
            onClick={() => setToast(null)}
            className="text-xs text-good/80 hover:text-good"
            aria-label="Dismiss"
          >
            ×
          </button>
        </div>
      )}

      {deals === null ? (
        <div className="rounded-md border border-line bg-muted/20 px-3 py-6 text-center text-sm text-white/40">
          Loading deals…
        </div>
      ) : (
        <>
          {/* Mobile: card list. Tables get unreadable below ~640px. */}
          <div className="md:hidden">
            <DealCardList deals={deals} />
          </div>
          {/* Desktop: full table with sortable columns + inline actions. */}
          <div className="hidden md:block">
            <DataTable
              data={deals}
              columns={columns}
              filterPlaceholder="Filter by ref, buyer, product…"
              emptyState="No deals match the current filter. Try clearing status or adjusting search."
            />
          </div>
        </>
      )}
    </div>
  );
}

/**
 * Mobile card list. One card per deal; the whole card routes to the
 * detail page. Shows the fields you actually want at a glance —
 * deal ref + status on top, buyer + product/volume underneath, plus
 * any compliance/OFAC flag as an amber pill. No inline status
 * dropdown on mobile (it doesn't fit usefully); status change still
 * works from the detail page.
 */
function DealCardList({ deals }: { deals: DealRow[] }) {
  if (deals.length === 0) {
    return (
      <div className="rounded-md border border-line bg-muted/20 px-3 py-6 text-center text-sm text-white/40">
        No deals match the current filter.
      </div>
    );
  }
  return (
    <ul className="flex flex-col gap-2">
      {deals.map((d) => (
        <li key={d.id}>
          <Link
            href={`/app/deals/${d.id}`}
            className="block rounded-lg border border-line bg-muted/20 p-3 transition-colors hover:border-accent/60 hover:bg-muted/40"
          >
            <div className="flex items-start justify-between gap-2">
              <span className="font-mono text-sm text-accent">{d.dealRef}</span>
              <StatusPill status={d.status} />
            </div>
            <div className="mt-1.5 truncate text-sm text-white">
              {d.buyerName ?? "Unknown buyer"}
            </div>
            <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-white/60">
              <span>{PRODUCT_LABELS[d.product] ?? d.product}</span>
              <span aria-hidden="true" className="text-white/30">·</span>
              <span>{formatVolume(d.volumeUsg)}</span>
              <span aria-hidden="true" className="text-white/30">·</span>
              <span className="uppercase">{d.incoterm}</span>
              {d.laycanStart ? (
                <>
                  <span aria-hidden="true" className="text-white/30">·</span>
                  <span>{formatLaycan(d.laycanStart, d.laycanEnd)}</span>
                </>
              ) : null}
            </div>
            {(d.complianceHold || d.ofacStatus !== "cleared") && (
              <div className="mt-2 flex flex-wrap gap-1">
                {d.complianceHold && (
                  <span className="rounded bg-bad/20 px-1.5 py-0.5 text-[10px] text-bad">
                    compliance hold
                  </span>
                )}
                {d.ofacStatus !== "cleared" && (
                  <span className="rounded bg-warn/20 px-1.5 py-0.5 text-[10px] text-warn">
                    ofac: {d.ofacStatus.replace("_", " ")}
                  </span>
                )}
              </div>
            )}
          </Link>
        </li>
      ))}
    </ul>
  );
}

function StatusPill({ status }: { status: string }) {
  const palette: Record<string, string> = {
    draft: "bg-muted/60 text-white/70",
    negotiating: "bg-warn/20 text-warn",
    approved: "bg-good/20 text-good",
    in_transit: "bg-accent/20 text-accent",
    delivered: "bg-good/30 text-good",
    settled: "bg-muted/80 text-white/50",
    cancelled: "bg-bad/20 text-bad",
  };
  return (
    <span
      className={`inline-block rounded px-1.5 py-0.5 text-xs ${
        palette[status] ?? "bg-muted/60 text-white/70"
      }`}
    >
      {status.replace("_", " ")}
    </span>
  );
}

function formatVolume(usg: number): string {
  if (usg >= 1_000_000) return `${(usg / 1_000_000).toFixed(1)}M USG`;
  if (usg >= 1_000) return `${(usg / 1_000).toFixed(0)}k USG`;
  return `${usg} USG`;
}

function formatLaycan(start: string | null, end: string | null): string {
  if (!start) return "—";
  if (!end) return short(start);
  if (start === end) return short(start);
  return `${short(start)} – ${short(end)}`;
}

function short(iso: string): string {
  // yyyy-mm-dd → MMM d
  const parts = iso.split("-");
  if (parts.length !== 3) return iso;
  const [, mm, dd] = parts;
  const months = [
    "Jan", "Feb", "Mar", "Apr", "May", "Jun",
    "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
  ];
  const idx = Number.parseInt(mm ?? "1", 10) - 1;
  const day = Number.parseInt(dd ?? "1", 10);
  return `${months[idx] ?? mm} ${day}`;
}
