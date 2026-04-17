"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { type ColumnDef } from "@tanstack/react-table";
import { DataTable } from "@/components/data-table/data-table";
import { NewDealForm } from "@/components/crm/new-deal-form";
import { DealStatusMenu } from "@/components/crm/deal-status-menu";

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
    fetch(`/api/deals${qs}`)
      .then(async (res) => {
        if (res.status === 404) {
          throw new Error(
            "apps/api doesn't have /deals yet — redeploy it on Fly.",
          );
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
        cell: ({ row }) => row.original.buyerName ?? row.original.buyerOrgId,
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
    <div className="mx-auto flex h-full max-w-6xl flex-col gap-4 px-6 py-6">
      <header className="flex items-baseline justify-between">
        <div>
          <h1 className="text-xl font-semibold text-white">Deals</h1>
          <p className="text-sm text-white/60">
            Fuel deals, sortable and filterable. Click a row to open the deal detail.
          </p>
        </div>
        <div className="flex gap-2">
          <Link
            href="/app/chat?ask=Show%20me%20all%20deals%20with%20compliance%20holds"
            className="rounded-md border border-line px-3 py-1.5 text-sm text-white/80 hover:border-accent hover:text-white"
          >
            Ask Vex →
          </Link>
          <button
            type="button"
            onClick={() => setCreating(true)}
            className="rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-white hover:bg-accent/90"
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

      <div className="flex flex-wrap gap-1">
        {STATUS_FILTERS.map((s) => (
          <button
            key={s.value}
            type="button"
            onClick={() => setStatusFilter(s.value)}
            className={`rounded-md px-3 py-1 text-xs transition-colors ${
              statusFilter === s.value
                ? "bg-accent text-white"
                : "bg-muted/40 text-white/70 hover:bg-muted/60"
            }`}
          >
            {s.label}
          </button>
        ))}
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
        <DataTable
          data={deals}
          columns={columns}
          filterPlaceholder="Filter by ref, buyer, product…"
          emptyState="No deals match the current filter. Try clearing status or adjusting search."
        />
      )}
    </div>
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
