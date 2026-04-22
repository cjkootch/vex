"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { type ColumnDef } from "@tanstack/react-table";
import { DataTable } from "@/components/data-table/data-table";
import {
  FacetChips,
  ListToolbar,
} from "@/components/data-table/list-toolbar";
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
  contactCount: number;
  createdAt: string;
  updatedAt: string;
}

type StatusFilter = "" | "active" | "suppressed";
type FitFilter = "" | "high" | "mid" | "low" | "unknown";

export default function CompaniesPage() {
  const [organizations, setOrganizations] = useState<OrganizationRow[] | null>(null);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("active");
  const [industryFilter, setIndustryFilter] = useState<string>("");
  const [fitFilter, setFitFilter] = useState<FitFilter>("");

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

  const industries = useMemo<string[]>(() => {
    if (!organizations) return [];
    const set = new Set<string>();
    for (const o of organizations) {
      if (o.industry) set.add(o.industry);
    }
    return Array.from(set).sort();
  }, [organizations]);

  const filtered = useMemo<OrganizationRow[]>(() => {
    if (!organizations) return [];
    const q = search.trim().toLowerCase();
    return organizations.filter((o) => {
      if (statusFilter && o.status !== statusFilter) return false;
      if (industryFilter && o.industry !== industryFilter) return false;
      if (fitFilter) {
        const s = o.fitScore;
        if (fitFilter === "unknown" && s !== null) return false;
        if (fitFilter === "high" && (s === null || s < 0.8)) return false;
        if (fitFilter === "mid" && (s === null || s < 0.6 || s >= 0.8))
          return false;
        if (fitFilter === "low" && (s === null || s >= 0.6)) return false;
      }
      if (!q) return true;
      return (
        o.legalName.toLowerCase().includes(q) ||
        (o.domain?.toLowerCase().includes(q) ?? false) ||
        (o.industry?.toLowerCase().includes(q) ?? false)
      );
    });
  }, [organizations, search, statusFilter, industryFilter, fitFilter]);

  const statusCounts = useMemo(() => {
    const all = organizations?.length ?? 0;
    let active = 0;
    let suppressed = 0;
    for (const o of organizations ?? []) {
      if (o.status === "active") active++;
      else if (o.status === "suppressed") suppressed++;
    }
    return { all, active, suppressed };
  }, [organizations]);

  const columns = useMemo<ColumnDef<OrganizationRow, unknown>[]>(
    () => [
      {
        accessorKey: "legalName",
        header: "Company",
        cell: ({ row }) => (
          <div className="flex items-center gap-2.5 min-w-0">
            <Monogram name={row.original.legalName} />
            <div className="flex min-w-0 flex-col">
              <Link
                href={`/app/companies/${row.original.id}`}
                className="truncate font-medium text-text-primary transition-colors hover:text-accent-strong hover:underline"
                onClick={(e) => e.stopPropagation()}
              >
                {row.original.legalName}
              </Link>
              {row.original.domain ? (
                <span className="num-mono truncate text-[11px] text-text-muted">
                  {row.original.domain}
                </span>
              ) : null}
            </div>
          </div>
        ),
      },
      {
        accessorKey: "industry",
        header: "Industry",
        cell: ({ getValue }) => {
          const v = getValue<string | null>();
          return v ? (
            <span className="text-text-secondary">{v}</span>
          ) : (
            <span className="text-text-muted/50">—</span>
          );
        },
      },
      {
        accessorKey: "fitScore",
        header: "Fit",
        cell: ({ getValue }) => <FitPill score={getValue<number | null>()} />,
      },
      {
        accessorKey: "contactCount",
        header: "Contacts",
        cell: ({ getValue }) => {
          const n = getValue<number>();
          return (
            <span className={`num ${n > 0 ? "text-text-primary" : "text-text-muted/60"}`}>
              {n}
            </span>
          );
        },
      },
      {
        accessorKey: "status",
        header: "Status",
        cell: ({ getValue }) => {
          const v = getValue<string>();
          if (v === "suppressed") {
            return (
              <span className="rounded-md border border-bad/40 bg-bad/10 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider2 text-bad">
                Suppressed
              </span>
            );
          }
          if (v === "active") {
            return <span className="text-text-muted/50">—</span>;
          }
          return (
            <span className="rounded bg-surface-2 px-1.5 py-0.5 text-[10px] uppercase tracking-wider2 text-text-muted">
              {v}
            </span>
          );
        },
      },
      {
        accessorKey: "updatedAt",
        header: "Updated",
        cell: ({ getValue }) => (
          <span className="num text-text-muted">
            {formatRelative(getValue<string>())}
          </span>
        ),
      },
    ],
    [],
  );

  const anyFilterActive =
    Boolean(search) ||
    statusFilter !== "active" ||
    Boolean(industryFilter) ||
    Boolean(fitFilter);

  return (
    <div className="mx-auto flex h-full max-w-7xl flex-col gap-4 px-6 py-6">
      <header className="flex flex-wrap items-center justify-between gap-3 border-b border-line-soft pb-4">
        <div className="flex items-baseline gap-3">
          <div className="flex flex-col">
            <span className="text-eyebrow text-text-muted">Counterparties</span>
            <h1 className="text-title text-text-primary">Companies</h1>
          </div>
          <span className="hidden text-sm text-text-muted sm:inline">
            · {statusCounts.all} total
          </span>
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
                  : filtered;
              const csv = toCsv(
                [
                  "legal_name",
                  "domain",
                  "industry",
                  "fit_score",
                  "status",
                  "contact_count",
                  "created_at",
                  "updated_at",
                ],
                target.map((o) => [
                  o.legalName,
                  o.domain ?? "",
                  o.industry ?? "",
                  o.fitScore,
                  o.status,
                  o.contactCount,
                  o.createdAt,
                  o.updatedAt,
                ]),
              );
              downloadCsv(
                `companies-${new Date().toISOString().slice(0, 10)}.csv`,
                csv,
              );
            }}
            className="rounded-md border border-line-soft bg-surface-2/60 px-3 py-1.5 text-sm text-text-secondary transition-colors hover:border-line-strong hover:text-text-primary disabled:opacity-40"
          >
            {selectedIds.size > 0 ? `CSV (${selectedIds.size})` : "CSV"}
          </button>
          <button
            type="button"
            onClick={() => setCreating(true)}
            className="rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-white transition-colors hover:bg-accent-strong"
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
                    contactCount: 0,
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

      <ListToolbar
        search={search}
        onSearchChange={setSearch}
        searchPlaceholder="Filter by name, domain, industry…"
        count={filtered.length}
        facets={
          <>
            <FacetChips<StatusFilter>
              value={statusFilter}
              onChange={setStatusFilter}
              options={[
                { label: "Active", value: "active", count: statusCounts.active },
                {
                  label: "Suppressed",
                  value: "suppressed",
                  count: statusCounts.suppressed,
                },
                { label: "All", value: "", count: statusCounts.all },
              ]}
            />
            <FacetChips<FitFilter>
              label="Fit"
              value={fitFilter}
              onChange={setFitFilter}
              options={[
                { label: "Any", value: "" },
                { label: "≥80", value: "high" },
                { label: "60–79", value: "mid" },
                { label: "<60", value: "low" },
                { label: "—", value: "unknown" },
              ]}
            />
            {industries.length > 0 ? (
              <div className="flex items-center gap-1.5">
                <span className="text-eyebrow text-text-muted">Industry</span>
                <select
                  value={industryFilter}
                  onChange={(e) => setIndustryFilter(e.target.value)}
                  className="rounded-md border border-line-soft bg-surface-2/60 px-2 py-1 text-xs text-text-primary transition-colors focus:border-accent focus:outline-none"
                >
                  <option value="">All</option>
                  {industries.map((ind) => (
                    <option key={ind} value={ind}>
                      {ind}
                    </option>
                  ))}
                </select>
              </div>
            ) : null}
            {anyFilterActive ? (
              <button
                type="button"
                onClick={() => {
                  setSearch("");
                  setStatusFilter("active");
                  setIndustryFilter("");
                  setFitFilter("");
                }}
                className="text-xs text-text-muted transition-colors hover:text-text-secondary"
              >
                Clear filters
              </button>
            ) : null}
          </>
        }
      />

      {organizations === null ? (
        <div className="rounded-md border border-line-soft bg-surface-2/30 px-3 py-6 text-center text-sm text-text-muted">
          Loading companies…
        </div>
      ) : (
        <>
          {selectedIds.size > 0 && (
            <div className="mb-2 flex items-center justify-between rounded-md border border-accent/40 bg-accent-soft/30 px-3 py-2 text-sm">
              <span className="text-text-primary">
                <span className="num-mono">{selectedIds.size}</span> compan
                {selectedIds.size === 1 ? "y" : "ies"} selected
              </span>
              <button
                type="button"
                onClick={() => setSelectedIds(new Set())}
                className="text-xs text-text-muted hover:text-text-primary"
              >
                Clear
              </button>
            </div>
          )}
          <DataTable
            data={filtered}
            columns={columns}
            filter={search}
            hideToolbar
            emptyState={
              anyFilterActive
                ? "No companies match the current filters."
                : "No companies yet. Load organizations via ingestion or seed to populate this list."
            }
            selectedIds={selectedIds}
            onSelectionChange={setSelectedIds}
            getRowId={(o) => o.id}
          />
        </>
      )}
    </div>
  );
}

function Monogram({ name }: { name: string }) {
  const initials = name
    .split(" ")
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]?.toUpperCase() ?? "")
    .join("");
  return (
    <div
      aria-hidden="true"
      className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-md border border-line-soft bg-surface-2/80 text-[11px] font-semibold text-accent-strong"
    >
      {initials || "·"}
    </div>
  );
}

function FitPill({ score }: { score: number | null }) {
  if (score === null) return <span className="text-text-muted/50">—</span>;
  const pct = Math.round(score * 100);
  const palette =
    pct >= 80
      ? "border-emerald-400/40 bg-emerald-400/10 text-emerald-300"
      : pct >= 60
        ? "border-warn/40 bg-warn/10 text-warn"
        : "border-line-soft bg-surface-2/60 text-text-muted";
  return (
    <span
      className={`num inline-block rounded-md border px-1.5 py-0.5 text-[11px] font-semibold ${palette}`}
    >
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
