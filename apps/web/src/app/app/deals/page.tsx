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
  lineOfBusiness?: string;
  volumeUnit?: string;
  productionLeadTimeWeeks?: number | null;
  coldChainRequired?: boolean;
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
  jet_a: "Jet A",
  jet_a1: "Jet A1",
  gasoline_87: "Gasoline 87",
  gasoline_91: "Gasoline 91",
  avgas: "Avgas",
  lfo: "LFO",
  hfo: "HFO",
  lng: "LNG",
  lpg: "LPG",
  biodiesel_b20: "Biodiesel B20",
  // Food line of business
  rice: "Rice",
  beans: "Beans",
  pork: "Pork",
  chicken: "Chicken",
  cooking_oil: "Cooking oil",
  powdered_milk: "Powdered milk",
};

const LOB_FILTERS = [
  { label: "All", value: "" },
  { label: "Fuel", value: "fuel" },
  { label: "Food", value: "food" },
] as const;

export default function DealsPage() {
  const [deals, setDeals] = useState<DealRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState<string>("");
  const [lobFilter, setLobFilter] = useState<string>("");
  const [creating, setCreating] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());

  useEffect(() => {
    let cancelled = false;
    const params = new URLSearchParams();
    if (statusFilter) params.set("status", statusFilter);
    if (lobFilter) params.set("line_of_business", lobFilter);
    const qs = params.toString() ? `?${params.toString()}` : "";
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
  }, [statusFilter, lobFilter]);

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
      <header className="flex items-start justify-between gap-3 border-b border-line-soft pb-5">
        <div className="min-w-0">
          <div className="text-eyebrow text-text-muted">Pipeline</div>
          <h1 className="mt-1 text-title text-text-primary">Deals</h1>
          <p className="mt-2 hidden text-sm text-text-secondary md:block">
            Fuel deals, sortable and filterable. Click a row to open the deal detail.
          </p>
        </div>
        <div className="flex flex-shrink-0 items-center gap-2">
          <button
            type="button"
            disabled={!deals || deals.length === 0}
            onClick={() => {
              if (!deals) return;
              const target =
                selectedIds.size > 0
                  ? deals.filter((d) => selectedIds.has(d.id))
                  : deals;
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
                target.map((d) => [
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
            {selectedIds.size > 0 ? `CSV (${selectedIds.size})` : "CSV"}
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
      <div className="flex items-center gap-1 text-xs">
        <span className="mr-1 uppercase tracking-wide text-white/40">Line</span>
        {LOB_FILTERS.map((l) => (
          <button
            key={l.value}
            type="button"
            onClick={() => setLobFilter(l.value)}
            className={`rounded-md px-2 py-1 transition-colors ${
              lobFilter === l.value
                ? "bg-accent text-white"
                : "bg-muted/40 text-white/70 hover:bg-muted/60"
            }`}
          >
            {l.label}
          </button>
        ))}
      </div>
      <SavedViews
        currentStatus={statusFilter}
        onApply={(v) => setStatusFilter(v)}
      />

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
            {selectedIds.size > 0 && (
              <div className="mb-2 flex items-center justify-between rounded-md border border-accent/40 bg-accent/10 px-3 py-2 text-sm">
                <span className="text-white">
                  <span className="font-mono">{selectedIds.size}</span> deal
                  {selectedIds.size === 1 ? "" : "s"} selected
                </span>
                <button
                  type="button"
                  onClick={() => setSelectedIds(new Set())}
                  className="text-xs text-white/60 hover:text-white"
                >
                  Clear
                </button>
              </div>
            )}
            <DataTable
              data={deals}
              columns={columns}
              filterPlaceholder="Filter by ref, buyer, product…"
              emptyState="No deals match the current filter. Try clearing status or adjusting search."
              selectedIds={selectedIds}
              onSelectionChange={setSelectedIds}
              getRowId={(d) => d.id}
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

interface SavedView {
  name: string;
  statusFilter: string;
}

const VIEWS_KEY = "vex.deals.views";

function SavedViews({
  currentStatus,
  onApply,
}: {
  currentStatus: string;
  onApply: (status: string) => void;
}) {
  const [views, setViews] = useState<SavedView[]>([]);

  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(VIEWS_KEY);
      if (raw) setViews(JSON.parse(raw) as SavedView[]);
    } catch {
      /* ignore parse errors — stale state stays empty */
    }
  }, []);

  function persist(next: SavedView[]): void {
    setViews(next);
    try {
      window.localStorage.setItem(VIEWS_KEY, JSON.stringify(next));
    } catch {
      /* quota exceeded or disabled — view is still in memory for the session */
    }
  }

  function saveCurrent(): void {
    const name = window.prompt(
      "Name this view (e.g. \"open jet fuel\", \"my Trinidad deals\")",
    );
    if (!name || !name.trim()) return;
    const next = [
      ...views.filter((v) => v.name !== name),
      { name: name.trim(), statusFilter: currentStatus },
    ];
    persist(next);
  }

  function removeView(name: string): void {
    persist(views.filter((v) => v.name !== name));
  }

  if (views.length === 0) {
    return (
      <div className="flex items-center gap-2 text-xs text-white/40">
        <span>No saved views yet.</span>
        <button
          type="button"
          onClick={saveCurrent}
          className="rounded-md border border-line bg-muted/40 px-2 py-1 text-white/70 hover:text-white"
        >
          Save current filter
        </button>
      </div>
    );
  }

  return (
    <div className="flex flex-wrap items-center gap-2">
      <span className="text-[11px] uppercase tracking-wide text-white/40">
        Views
      </span>
      {views.map((v) => (
        <div
          key={v.name}
          className="group inline-flex items-center overflow-hidden rounded-md border border-line bg-muted/40 text-xs"
        >
          <button
            type="button"
            onClick={() => onApply(v.statusFilter)}
            className={`px-2 py-1 hover:bg-muted/60 ${
              currentStatus === v.statusFilter
                ? "text-accent"
                : "text-white/80"
            }`}
          >
            {v.name}
          </button>
          <button
            type="button"
            onClick={() => removeView(v.name)}
            aria-label={`Delete view ${v.name}`}
            className="border-l border-line/60 px-1.5 py-1 text-white/40 hover:text-bad"
          >
            ×
          </button>
        </div>
      ))}
      <button
        type="button"
        onClick={saveCurrent}
        className="rounded-md border border-line/60 bg-muted/20 px-2 py-1 text-xs text-white/60 hover:bg-muted/40"
      >
        + Save current
      </button>
    </div>
  );
}
