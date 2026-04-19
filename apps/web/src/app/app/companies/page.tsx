"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { type ColumnDef } from "@tanstack/react-table";
import { DataTable } from "@/components/data-table/data-table";
import { NewCompanyForm } from "@/components/crm/new-company-form";
import { fetchWithRetry } from "@/lib/fetch-with-retry";
import { downloadCsv, toCsv } from "@/lib/csv";

interface OrganizationRow {
  id: string;
  legalName: string;
  domain: string | null;
  industry: string | null;
  fitScore: number | null;
  status: string;
  kind: string | null;
  contactCount: number;
  productCount: number;
  dealCount: number;
  createdAt: string;
  updatedAt: string;
}

export default function CompaniesPage() {
  const [organizations, setOrganizations] = useState<OrganizationRow[] | null>(null);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetchWithRetry("/api/organizations", {
      onWaking: () => {
        if (!cancelled) setError("API is waking up…");
      },
    })
      .then(async (res) => {
        if (res.status === 502 || res.status === 503) {
          throw new Error("API is still waking up. Try again in a moment.");
        }
        if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
        return res.json();
      })
      .then((body: unknown) => {
        if (cancelled) return;
        // Defensive: if the upstream API is stale (e.g. Fly hasn't
        // redeployed yet and still has the Sprint-4 echo stub), the
        // body won't have an `organizations` array. Treat that as
        // empty + surface a warning instead of crashing the page.
        const rows =
          typeof body === "object" && body !== null &&
          Array.isArray((body as { organizations?: unknown }).organizations)
            ? ((body as { organizations: OrganizationRow[] }).organizations)
            : null;
        if (rows === null) {
          setOrganizations([]);
          setError(
            "apps/api returned an unexpected payload — redeploy it or wait for Fly to sync.",
          );
          return;
        }
        setOrganizations(rows);
        setError(null);
      })
      .catch((err: Error) => {
        if (!cancelled) {
          setError(err.message);
          setOrganizations([]);
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const columns = useMemo<ColumnDef<OrganizationRow, unknown>[]>(
    () => [
      {
        accessorKey: "legalName",
        header: "Company",
        cell: ({ row }) => (
          <div className="flex items-center gap-2">
            <Link
              href={`/app/companies/${row.original.id}`}
              className="font-medium text-accent hover:underline"
              onClick={(e) => e.stopPropagation()}
            >
              {row.original.legalName}
            </Link>
            <KindBadge kind={row.original.kind} />
          </div>
        ),
      },
      {
        accessorKey: "domain",
        header: "Domain",
        cell: ({ getValue }) => getValue<string | null>() ?? "—",
      },
      {
        accessorKey: "industry",
        header: "Industry",
        cell: ({ getValue }) => getValue<string | null>() ?? "—",
      },
      {
        accessorKey: "fitScore",
        header: "Fit",
        cell: ({ getValue }) => <FitPill score={getValue<number | null>()} />,
      },
      {
        accessorKey: "contactCount",
        header: "Contacts",
        cell: ({ getValue }) => getValue<number>(),
      },
      {
        accessorKey: "productCount",
        header: "Products",
        cell: ({ getValue }) => <CountPill value={getValue<number>()} />,
      },
      {
        accessorKey: "dealCount",
        header: "Deals",
        cell: ({ getValue }) => <CountPill value={getValue<number>()} />,
      },
      {
        accessorKey: "status",
        header: "Status",
        cell: ({ getValue }) => (
          <span className="rounded bg-muted/60 px-1.5 py-0.5 text-xs text-white/70">
            {getValue<string>()}
          </span>
        ),
      },
      {
        accessorKey: "updatedAt",
        header: "Updated",
        cell: ({ getValue }) => formatRelative(getValue<string>()),
      },
    ],
    [],
  );

  return (
    <div className="mx-auto flex h-full max-w-6xl flex-col gap-4 px-6 py-6">
      <header className="flex items-baseline justify-between">
        <div>
          <h1 className="text-xl font-semibold text-white">Companies</h1>
          <p className="text-sm text-white/60">
            All organizations in your workspace. Click a name to research it with Vex.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            disabled={!organizations || organizations.length === 0}
            onClick={() => {
              if (!organizations) return;
              const target =
                selectedIds.size > 0
                  ? organizations.filter((o) => selectedIds.has(o.id))
                  : organizations;
              const csv = toCsv(
                [
                  "legal_name",
                  "domain",
                  "industry",
                  "fit_score",
                  "status",
                  "kind",
                  "contact_count",
                  "product_count",
                  "deal_count",
                  "created_at",
                  "updated_at",
                ],
                target.map((o) => [
                  o.legalName,
                  o.domain ?? "",
                  o.industry ?? "",
                  o.fitScore,
                  o.status,
                  o.kind ?? "",
                  o.contactCount,
                  o.productCount,
                  o.dealCount,
                  o.createdAt,
                  o.updatedAt,
                ]),
              );
              downloadCsv(
                `companies-${new Date().toISOString().slice(0, 10)}.csv`,
                csv,
              );
            }}
            className="rounded-md border border-line bg-muted/40 px-3 py-1.5 text-sm text-white/80 hover:bg-muted/60 disabled:opacity-40"
          >
            {selectedIds.size > 0 ? `CSV (${selectedIds.size})` : "CSV"}
          </button>
          <button
            type="button"
            onClick={() => setCreating(true)}
            className="rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-white hover:bg-accent/90"
          >
            + New company
          </button>
        </div>
      </header>

      <NewCompanyForm
        open={creating}
        onClose={() => setCreating(false)}
        onCreated={(created) => {
          setOrganizations((prev) =>
            prev
              ? [
                  {
                    id: created.id,
                    legalName: created.legalName,
                    domain: null,
                    industry: null,
                    fitScore: null,
                    status: "active",
                    kind: null,
                    contactCount: 0,
                    productCount: 0,
                    dealCount: 0,
                    createdAt: new Date().toISOString(),
                    updatedAt: new Date().toISOString(),
                  },
                  ...prev,
                ]
              : prev,
          );
        }}
      />

      {error && (
        <div className="rounded-md border border-bad/40 bg-bad/10 px-3 py-2 text-sm text-bad">
          Couldn&apos;t load companies: {error}
        </div>
      )}

      {organizations === null ? (
        <div className="rounded-md border border-line bg-muted/20 px-3 py-6 text-center text-sm text-white/40">
          Loading companies…
        </div>
      ) : (
        <>
          {selectedIds.size > 0 && (
            <div className="mb-2 flex items-center justify-between rounded-md border border-accent/40 bg-accent/10 px-3 py-2 text-sm">
              <span className="text-white">
                <span className="font-mono">{selectedIds.size}</span> compan
                {selectedIds.size === 1 ? "y" : "ies"} selected
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
            data={organizations}
            columns={columns}
            filterPlaceholder="Filter by name, domain, industry…"
            emptyState="No companies yet. Load organizations via ingestion or seed to populate this list."
            selectedIds={selectedIds}
            onSelectionChange={setSelectedIds}
            getRowId={(o) => o.id}
          />
        </>
      )}
    </div>
  );
}

function KindBadge({ kind }: { kind: string | null }): React.ReactElement | null {
  if (!kind) return null;
  const palette: Record<string, string> = {
    buyer: "bg-accent/20 text-accent",
    supplier: "bg-good/20 text-good",
    broker: "bg-warn/20 text-warn",
    producer: "bg-good/20 text-good",
    carrier: "bg-muted/60 text-white/70",
  };
  const cls = palette[kind] ?? "bg-muted/60 text-white/70";
  return (
    <span
      className={`rounded px-1.5 py-0.5 text-[10px] uppercase tracking-wide ${cls}`}
    >
      {kind}
    </span>
  );
}

function CountPill({ value }: { value: number }): React.ReactElement {
  if (value === 0) return <span className="text-white/30">0</span>;
  return (
    <span className="inline-block min-w-[1.5rem] rounded bg-muted/60 px-1.5 py-0.5 text-center text-xs text-white/80">
      {value}
    </span>
  );
}

function FitPill({ score }: { score: number | null }) {
  if (score === null) return <span className="text-white/40">—</span>;
  const pct = Math.round(score * 100);
  const palette =
    pct >= 80
      ? "bg-good/20 text-good"
      : pct >= 60
        ? "bg-warn/20 text-warn"
        : "bg-muted/60 text-white/70";
  return (
    <span className={`inline-block rounded px-1.5 py-0.5 text-xs ${palette}`}>
      {pct}
    </span>
  );
}

function formatRelative(iso: string): string {
  const then = new Date(iso).getTime();
  if (!Number.isFinite(then)) return iso;
  const diffMs = Date.now() - then;
  const minutes = Math.floor(diffMs / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  const months = Math.floor(days / 30);
  return `${months}mo ago`;
}
