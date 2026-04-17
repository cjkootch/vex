"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { type ColumnDef } from "@tanstack/react-table";
import { DataTable } from "@/components/data-table/data-table";
import { NewContactForm } from "@/components/crm/new-contact-form";

interface ContactOrgLink {
  orgId: string;
  role: string | null;
  isPrimary: boolean;
}

interface ContactRow {
  id: string;
  tenantId: string;
  orgId: string;
  fullName: string;
  title: string | null;
  emails: string[];
  phones: string[];
  status: string;
  optOutAt: string | null;
  optOutReason: string | null;
  updatedAt: string;
  orgs: ContactOrgLink[];
}

interface OrgLookup {
  [id: string]: string;
}

const FILTER_TABS = [
  { label: "Active", value: "active" },
  { label: "Suppressed", value: "suppressed" },
] as const;

export default function ContactsPage() {
  const [contacts, setContacts] = useState<ContactRow[] | null>(null);
  const [orgLookup, setOrgLookup] = useState<OrgLookup>({});
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<"active" | "suppressed">("active");
  const [creating, setCreating] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setContacts(null);
    fetch(`/api/contacts?status=${tab}`)
      .then(async (res) => {
        if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
        return res.json();
      })
      .then((body: { contacts: ContactRow[] }) => {
        if (!cancelled) {
          setContacts(body.contacts);
          setError(null);
        }
      })
      .catch((err: Error) => {
        if (!cancelled) {
          setError(err.message);
          setContacts([]);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [tab]);

  // Separate fetch so the chip renderer can show "Acme" rather than
  // the raw ULID when no memberships table join is available yet.
  useEffect(() => {
    let cancelled = false;
    fetch("/api/organizations")
      .then(async (res) => {
        if (!res.ok) throw new Error(`${res.status}`);
        return res.json();
      })
      .then((body: { organizations: Array<{ id: string; legalName: string }> }) => {
        if (cancelled) return;
        const map: OrgLookup = {};
        for (const o of body.organizations) map[o.id] = o.legalName;
        setOrgLookup(map);
      })
      .catch(() => {
        /* chips fall back to ids */
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const columns = useMemo<ColumnDef<ContactRow, unknown>[]>(
    () => [
      {
        accessorKey: "fullName",
        header: "Name",
        cell: ({ row }) => (
          <Link
            href={`/app/contacts/${row.original.id}`}
            className="font-medium text-accent hover:underline"
            onClick={(e) => e.stopPropagation()}
          >
            {row.original.fullName}
          </Link>
        ),
      },
      {
        accessorKey: "title",
        header: "Title",
        cell: ({ getValue }) => getValue<string | null>() ?? "—",
      },
      {
        id: "companies",
        header: "Companies",
        cell: ({ row }) => {
          const orgs = row.original.orgs ?? [];
          if (orgs.length === 0) return <span className="text-white/40">—</span>;
          return (
            <div className="flex flex-wrap gap-1">
              {orgs.map((o) => (
                <span
                  key={o.orgId}
                  title={o.role ?? undefined}
                  className={`rounded px-1.5 py-0.5 text-xs ${
                    o.isPrimary
                      ? "bg-accent/25 text-accent"
                      : "bg-muted/60 text-white/70"
                  }`}
                >
                  {orgLookup[o.orgId] ?? o.orgId.slice(-6)}
                  {o.isPrimary && (
                    <span className="ml-1 text-[10px] uppercase tracking-wider text-accent/80">
                      ★
                    </span>
                  )}
                </span>
              ))}
            </div>
          );
        },
      },
      {
        id: "email",
        header: "Email",
        cell: ({ row }) => row.original.emails[0] ?? "—",
      },
      {
        id: "phone",
        header: "Phone",
        cell: ({ row }) => row.original.phones[0] ?? "—",
      },
      {
        id: "status",
        header: "Status",
        cell: ({ row }) => {
          if (row.original.optOutAt) {
            return (
              <span
                className="rounded bg-bad/20 px-1.5 py-0.5 text-xs text-bad"
                title={row.original.optOutReason ?? "suppressed"}
              >
                suppressed
              </span>
            );
          }
          return (
            <span className="rounded bg-good/20 px-1.5 py-0.5 text-xs text-good">
              active
            </span>
          );
        },
      },
      {
        accessorKey: "updatedAt",
        header: "Updated",
        cell: ({ getValue }) => formatRelative(getValue<string>()),
      },
    ],
    [orgLookup],
  );

  return (
    <div className="mx-auto flex h-full max-w-6xl flex-col gap-4 px-6 py-6">
      <header className="flex items-baseline justify-between">
        <div>
          <h1 className="text-xl font-semibold text-white">Contacts</h1>
          <p className="text-sm text-white/60">
            People across your workspace. Suppressed contacts are filtered out of outbound
            automation.
          </p>
        </div>
        <button
          type="button"
          onClick={() => setCreating(true)}
          className="rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-white hover:bg-accent/90"
        >
          + New contact
        </button>
      </header>

      <NewContactForm
        open={creating}
        onClose={() => setCreating(false)}
        onCreated={() => {
          // Easiest correct behaviour: refetch so the new row picks up
          // the server-assigned computed fields (status, timestamps).
          setContacts(null);
          setTab("active");
        }}
      />

      <div className="flex gap-1">
        {FILTER_TABS.map((t) => (
          <button
            key={t.value}
            type="button"
            onClick={() => setTab(t.value)}
            className={`rounded-md px-3 py-1 text-xs transition-colors ${
              tab === t.value
                ? "bg-accent text-white"
                : "bg-muted/40 text-white/70 hover:bg-muted/60"
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {error && (
        <div className="rounded-md border border-bad/40 bg-bad/10 px-3 py-2 text-sm text-bad">
          Couldn&apos;t load contacts: {error}
        </div>
      )}

      {contacts === null ? (
        <div className="rounded-md border border-line bg-muted/20 px-3 py-6 text-center text-sm text-white/40">
          Loading contacts…
        </div>
      ) : (
        <DataTable
          data={contacts}
          columns={columns}
          filterPlaceholder="Filter by name, title, email…"
          emptyState={
            tab === "suppressed"
              ? "No suppressed contacts. Opt-outs recorded here."
              : "No active contacts. Load contacts via ingestion or seed."
          }
        />
      )}
    </div>
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
