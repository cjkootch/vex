"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { type ColumnDef } from "@tanstack/react-table";
import { DataTable } from "@/components/data-table/data-table";
import {
  FacetChips,
  ListToolbar,
} from "@/components/data-table/list-toolbar";
import { NewContactForm } from "@/components/crm/new-contact-form";
import { fetchWithRetry } from "@/lib/fetch-with-retry";
import { downloadCsv, toCsv } from "@/lib/csv";

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

type StatusTab = "active" | "suppressed";
type ReachFilter = "" | "has_email" | "has_phone" | "has_both";

export default function ContactsPage() {
  const [contacts, setContacts] = useState<ContactRow[] | null>(null);
  const [orgLookup, setOrgLookup] = useState<OrgLookup>({});
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<StatusTab>("active");
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [creating, setCreating] = useState(false);
  const [archiveModalOpen, setArchiveModalOpen] = useState(false);
  const [archiveBusy, setArchiveBusy] = useState(false);
  const [archiveError, setArchiveError] = useState<string | null>(null);
  const [archiveConfirmText, setArchiveConfirmText] = useState("");

  const [search, setSearch] = useState("");
  const [companyFilter, setCompanyFilter] = useState<string>("");
  const [reachFilter, setReachFilter] = useState<ReachFilter>("");

  useEffect(() => {
    let cancelled = false;
    setContacts(null);
    fetchWithRetry(`/api/contacts?status=${tab}`, {
      onWaking: () => {
        if (!cancelled) setError("API is waking up…");
      },
    })
      .then(async (res) => {
        if (res.status === 404) {
          throw new Error(
            "apps/api doesn't have /contacts list yet — redeploy it on Fly.",
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
          Array.isArray((body as { contacts?: unknown }).contacts)
            ? ((body as { contacts: ContactRow[] }).contacts)
            : null;
        if (rows === null) {
          setContacts([]);
          setError("apps/api returned an unexpected payload.");
          return;
        }
        setContacts(rows);
        setError(null);
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

  const companyOptions = useMemo<Array<{ id: string; name: string }>>(() => {
    if (!contacts) return [];
    const ids = new Set<string>();
    for (const c of contacts) {
      for (const o of c.orgs ?? []) ids.add(o.orgId);
    }
    return Array.from(ids)
      .map((id) => ({ id, name: orgLookup[id] ?? id.slice(-6) }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [contacts, orgLookup]);

  const filtered = useMemo<ContactRow[]>(() => {
    if (!contacts) return [];
    const q = search.trim().toLowerCase();
    return contacts.filter((c) => {
      if (companyFilter) {
        if (!c.orgs.some((o) => o.orgId === companyFilter)) return false;
      }
      if (reachFilter === "has_email" && c.emails.length === 0) return false;
      if (reachFilter === "has_phone" && c.phones.length === 0) return false;
      if (
        reachFilter === "has_both" &&
        (c.emails.length === 0 || c.phones.length === 0)
      )
        return false;
      if (!q) return true;
      return (
        c.fullName.toLowerCase().includes(q) ||
        (c.title?.toLowerCase().includes(q) ?? false) ||
        c.emails.some((e) => e.toLowerCase().includes(q)) ||
        c.phones.some((p) => p.toLowerCase().includes(q))
      );
    });
  }, [contacts, search, companyFilter, reachFilter]);

  const columns = useMemo<ColumnDef<ContactRow, unknown>[]>(
    () => [
      {
        accessorKey: "fullName",
        header: "Name",
        cell: ({ row }) => (
          <div className="flex items-center gap-2.5 min-w-0">
            <Avatar name={row.original.fullName} />
            <div className="flex min-w-0 flex-col">
              <Link
                href={`/app/contacts/${row.original.id}`}
                className="truncate font-medium text-text-primary transition-colors hover:text-accent-strong hover:underline"
                onClick={(e) => e.stopPropagation()}
              >
                {row.original.fullName}
              </Link>
              {row.original.title ? (
                <span className="truncate text-[11px] text-text-muted">
                  {row.original.title}
                </span>
              ) : null}
            </div>
          </div>
        ),
      },
      {
        id: "companies",
        header: "Companies",
        cell: ({ row }) => {
          const orgs = row.original.orgs ?? [];
          if (orgs.length === 0) return <span className="text-text-muted/50">—</span>;
          const primary = orgs.find((o) => o.isPrimary) ?? orgs[0]!;
          const others = orgs.filter((o) => o !== primary);
          return (
            <div className="flex items-center gap-1.5">
              <Link
                href={`/app/companies/${primary.orgId}`}
                onClick={(e) => e.stopPropagation()}
                className="truncate text-text-secondary hover:text-text-primary hover:underline"
                title={primary.role ?? undefined}
              >
                {orgLookup[primary.orgId] ?? primary.orgId.slice(-6)}
              </Link>
              {others.length > 0 ? (
                <span
                  className="num rounded-full border border-line-soft bg-surface-2/60 px-1.5 py-0 text-[10px] text-text-muted"
                  title={others
                    .map((o) => orgLookup[o.orgId] ?? o.orgId)
                    .join(", ")}
                >
                  +{others.length}
                </span>
              ) : null}
            </div>
          );
        },
      },
      {
        id: "email",
        header: "Email",
        cell: ({ row }) => {
          const e = row.original.emails[0];
          if (!e) return <span className="text-text-muted/50">—</span>;
          return (
            <span className="num-mono truncate text-text-secondary" title={e}>
              {e}
            </span>
          );
        },
      },
      {
        id: "phone",
        header: "Phone",
        cell: ({ row }) => {
          const p = row.original.phones[0];
          if (!p) return <span className="text-text-muted/50">—</span>;
          return <span className="num-mono text-text-secondary">{p}</span>;
        },
      },
      {
        id: "status",
        header: "Status",
        cell: ({ row }) => {
          if (row.original.optOutAt) {
            return (
              <span
                className="rounded-md border border-bad/40 bg-bad/10 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider2 text-bad"
                title={row.original.optOutReason ?? "suppressed"}
              >
                Suppressed
              </span>
            );
          }
          return <span className="text-text-muted/50">—</span>;
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
    [orgLookup],
  );

  const anyFilterActive =
    Boolean(search) || Boolean(companyFilter) || Boolean(reachFilter);

  return (
    <div className="mx-auto flex h-full max-w-7xl flex-col gap-4 px-6 py-6">
      <header className="flex flex-wrap items-center justify-between gap-3 border-b border-line-soft pb-4">
        <div className="flex items-baseline gap-3">
          <div className="flex flex-col">
            <span className="text-eyebrow text-text-muted">Counterparties</span>
            <h1 className="text-title text-text-primary">Contacts</h1>
          </div>
          <span className="hidden text-sm text-text-muted sm:inline">
            · {contacts?.length ?? 0} {tab}
          </span>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            disabled={!contacts || contacts.length === 0}
            onClick={() => {
              if (!contacts) return;
              const target =
                selectedIds.size > 0
                  ? contacts.filter((c) => selectedIds.has(c.id))
                  : filtered;
              const csv = toCsv(
                [
                  "full_name",
                  "title",
                  "primary_email",
                  "primary_phone",
                  "status",
                  "orgs",
                  "opt_out_at",
                  "opt_out_reason",
                  "updated_at",
                ],
                target.map((c) => [
                  c.fullName,
                  c.title ?? "",
                  c.emails[0] ?? "",
                  c.phones[0] ?? "",
                  c.status,
                  c.orgs
                    .map((l) => orgLookup[l.orgId] ?? l.orgId)
                    .join("; "),
                  c.optOutAt ?? "",
                  c.optOutReason ?? "",
                  c.updatedAt,
                ]),
              );
              downloadCsv(
                `contacts-${new Date().toISOString().slice(0, 10)}.csv`,
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
            + New contact
          </button>
        </div>
      </header>

      <NewContactForm
        open={creating}
        onClose={() => setCreating(false)}
        onCreated={() => {
          setContacts(null);
          setTab("active");
        }}
      />

      <ListToolbar
        search={search}
        onSearchChange={setSearch}
        searchPlaceholder="Filter by name, title, email, phone…"
        count={filtered.length}
        facets={
          <>
            <FacetChips<StatusTab>
              value={tab}
              onChange={setTab}
              options={[
                { label: "Active", value: "active" },
                { label: "Suppressed", value: "suppressed" },
              ]}
            />
            <FacetChips<ReachFilter>
              label="Reach"
              value={reachFilter}
              onChange={setReachFilter}
              options={[
                { label: "Any", value: "" },
                { label: "Email", value: "has_email" },
                { label: "Phone", value: "has_phone" },
                { label: "Both", value: "has_both" },
              ]}
            />
            {companyOptions.length > 0 ? (
              <div className="flex items-center gap-1.5">
                <span className="text-eyebrow text-text-muted">Company</span>
                <select
                  value={companyFilter}
                  onChange={(e) => setCompanyFilter(e.target.value)}
                  className="max-w-[160px] rounded-md border border-line-soft bg-surface-2/60 px-2 py-1 text-xs text-text-primary transition-colors focus:border-accent focus:outline-none"
                >
                  <option value="">All</option>
                  {companyOptions.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
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
                  setCompanyFilter("");
                  setReachFilter("");
                }}
                className="text-xs text-text-muted transition-colors hover:text-text-secondary"
              >
                Clear filters
              </button>
            ) : null}
          </>
        }
      />

      {error && (
        <div className="rounded-md border border-bad/40 bg-bad/10 px-3 py-2 text-sm text-bad">
          Couldn&apos;t load contacts: {error}
        </div>
      )}

      {contacts === null ? (
        <div className="rounded-md border border-line-soft bg-surface-2/30 px-3 py-6 text-center text-sm text-text-muted">
          Loading contacts…
        </div>
      ) : (
        <>
          {selectedIds.size > 0 && (
            <div className="mb-2 flex items-center justify-between rounded-md border border-accent/40 bg-accent-soft/30 px-3 py-2 text-sm">
              <span className="text-text-primary">
                <span className="num-mono">{selectedIds.size}</span> contact
                {selectedIds.size === 1 ? "" : "s"} selected
              </span>
              <div className="flex items-center gap-3">
                <button
                  type="button"
                  onClick={() => {
                    setArchiveConfirmText("");
                    setArchiveError(null);
                    setArchiveModalOpen(true);
                  }}
                  className="rounded-md border border-bad/40 bg-bad/10 px-2.5 py-1 text-xs font-medium text-bad transition-colors hover:bg-bad/20"
                >
                  Delete {selectedIds.size}
                </button>
                <button
                  type="button"
                  onClick={() => setSelectedIds(new Set())}
                  className="text-xs text-text-muted hover:text-text-primary"
                >
                  Clear
                </button>
              </div>
            </div>
          )}

          {archiveModalOpen ? (
            <div
              className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
              onMouseDown={(e) => {
                if (e.target === e.currentTarget && !archiveBusy) {
                  setArchiveModalOpen(false);
                }
              }}
            >
              <div className="w-full max-w-md rounded-lg border border-line bg-bg p-5 text-white shadow-xl">
                <h2 className="text-base font-semibold">
                  Delete {selectedIds.size} contact
                  {selectedIds.size === 1 ? "" : "s"}?
                </h2>
                <p className="mt-2 text-sm text-white/70">
                  Selected contacts will be archived (soft-deleted).
                  They vanish from the active list but their
                  touchpoints, leads, and deal history stay intact.
                  An owner can restore them later.
                </p>
                <p className="mt-3 text-xs text-white/50">
                  Type <span className="font-mono text-white">DELETE</span> below to confirm.
                </p>
                <input
                  type="text"
                  value={archiveConfirmText}
                  onChange={(e) => setArchiveConfirmText(e.target.value)}
                  placeholder="DELETE"
                  disabled={archiveBusy}
                  autoFocus
                  className="mt-2 w-full rounded-md border border-line bg-muted/30 px-3 py-1.5 font-mono text-sm text-white placeholder-white/30 focus:border-white/30 focus:outline-none"
                />
                {archiveError ? (
                  <p className="mt-2 text-xs text-red-200">{archiveError}</p>
                ) : null}
                <div className="mt-4 flex justify-end gap-2">
                  <button
                    type="button"
                    disabled={archiveBusy}
                    onClick={() => setArchiveModalOpen(false)}
                    className="rounded-md border border-line bg-muted/30 px-3 py-1.5 text-sm text-white/80 transition hover:bg-muted/50 disabled:opacity-50"
                  >
                    Cancel
                  </button>
                  <button
                    type="button"
                    disabled={archiveBusy || archiveConfirmText !== "DELETE"}
                    onClick={async () => {
                      setArchiveBusy(true);
                      setArchiveError(null);
                      try {
                        const ids = Array.from(selectedIds);
                        const res = await fetch(
                          "/api/contacts/bulk-archive",
                          {
                            method: "POST",
                            headers: { "content-type": "application/json" },
                            body: JSON.stringify({ contactIds: ids }),
                          },
                        );
                        if (!res.ok) {
                          const text = await res.text();
                          throw new Error(
                            `bulk-archive → ${res.status}: ${text.slice(0, 200)}`,
                          );
                        }
                        const payload = (await res.json()) as {
                          archivedCount: number;
                          archivedIds: string[];
                        };
                        const archivedSet = new Set(payload.archivedIds);
                        setContacts((prev) =>
                          prev
                            ? prev.filter((c) => !archivedSet.has(c.id))
                            : prev,
                        );
                        setSelectedIds(new Set());
                        setArchiveModalOpen(false);
                        setArchiveConfirmText("");
                      } catch (err) {
                        setArchiveError((err as Error).message);
                      } finally {
                        setArchiveBusy(false);
                      }
                    }}
                    className="rounded-md bg-red-500/80 px-3 py-1.5 text-sm font-medium text-white transition hover:bg-red-500 disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    {archiveBusy
                      ? "Archiving…"
                      : `Delete ${selectedIds.size}`}
                  </button>
                </div>
              </div>
            </div>
          ) : null}
          <DataTable
            data={filtered}
            columns={columns}
            filter={search}
            hideToolbar
            emptyState={
              anyFilterActive
                ? "No contacts match the current filters."
                : tab === "suppressed"
                  ? "No suppressed contacts. Opt-outs recorded here."
                  : "No active contacts. Load contacts via ingestion or seed."
            }
            selectedIds={selectedIds}
            onSelectionChange={setSelectedIds}
            getRowId={(c) => c.id}
          />
        </>
      )}
    </div>
  );
}

function Avatar({ name }: { name: string }) {
  const initials = name
    .split(" ")
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]?.toUpperCase() ?? "")
    .join("");
  return (
    <div
      aria-hidden="true"
      className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full border border-line-soft bg-surface-2/80 text-[11px] font-semibold text-accent-strong"
    >
      {initials || "·"}
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
