"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { type ColumnDef } from "@tanstack/react-table";
import { DataTable } from "@/components/data-table/data-table";
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

const FILTER_TABS = [
  { label: "Active", value: "active" },
  { label: "Suppressed", value: "suppressed" },
] as const;

export default function ContactsPage() {
  const [contacts, setContacts] = useState<ContactRow[] | null>(null);
  const [orgLookup, setOrgLookup] = useState<OrgLookup>({});
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<"active" | "suppressed">("active");
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [creating, setCreating] = useState(false);
  const [archiveModalOpen, setArchiveModalOpen] = useState(false);
  const [archiveBusy, setArchiveBusy] = useState(false);
  const [archiveError, setArchiveError] = useState<string | null>(null);
  const [archiveConfirmText, setArchiveConfirmText] = useState("");

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
        <div className="flex items-center gap-2">
          <button
            type="button"
            disabled={!contacts || contacts.length === 0}
            onClick={() => {
              if (!contacts) return;
              const target =
                selectedIds.size > 0
                  ? contacts.filter((c) => selectedIds.has(c.id))
                  : contacts;
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
            className="rounded-md border border-line bg-muted/40 px-3 py-1.5 text-sm text-white/80 hover:bg-muted/60 disabled:opacity-40"
          >
            {selectedIds.size > 0 ? `CSV (${selectedIds.size})` : "CSV"}
          </button>
          <button
            type="button"
            onClick={() => setCreating(true)}
            className="rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-white hover:bg-accent/90"
          >
            + New contact
          </button>
        </div>
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
        <>
          {selectedIds.size > 0 && (
            <div className="mb-2 flex items-center justify-between rounded-md border border-accent/40 bg-accent/10 px-3 py-2 text-sm">
              <span className="text-white">
                <span className="font-mono">{selectedIds.size}</span> contact
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
                  className="rounded-md border border-red-500/40 bg-red-500/10 px-2.5 py-1 text-xs font-medium text-red-200 transition hover:bg-red-500/20"
                >
                  Delete {selectedIds.size}
                </button>
                <button
                  type="button"
                  onClick={() => setSelectedIds(new Set())}
                  className="text-xs text-white/60 hover:text-white"
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
                        // Optimistic: drop archived rows from the list
                        // immediately so the UI feels instant. Keep
                        // any rows that didn't match (stale ids,
                        // already-archived) visible.
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
            data={contacts}
            columns={columns}
            filterPlaceholder="Filter by name, title, email…"
            emptyState={
              tab === "suppressed"
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
