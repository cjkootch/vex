"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { type ColumnDef } from "@tanstack/react-table";
import { DataTable } from "@/components/data-table/data-table";
import { NewCompanyForm } from "@/components/crm/new-company-form";

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

export default function CompaniesPage() {
  const [organizations, setOrganizations] = useState<OrganizationRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/organizations")
      .then(async (res) => {
        if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
        return res.json();
      })
      .then((body: { organizations: OrganizationRow[] }) => {
        if (!cancelled) {
          setOrganizations(body.organizations);
          setError(null);
        }
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
          <Link
            href={`/app/chat?ask=${encodeURIComponent(
              `Tell me about ${row.original.legalName}`,
            )}`}
            className="font-medium text-accent hover:underline"
            onClick={(e) => e.stopPropagation()}
          >
            {row.original.legalName}
          </Link>
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
        <button
          type="button"
          onClick={() => setCreating(true)}
          className="rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-white hover:bg-accent/90"
        >
          + New company
        </button>
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

      {organizations === null ? (
        <div className="rounded-md border border-line bg-muted/20 px-3 py-6 text-center text-sm text-white/40">
          Loading companies…
        </div>
      ) : (
        <DataTable
          data={organizations}
          columns={columns}
          filterPlaceholder="Filter by name, domain, industry…"
          emptyState="No companies yet. Load organizations via ingestion or seed to populate this list."
        />
      )}
    </div>
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
