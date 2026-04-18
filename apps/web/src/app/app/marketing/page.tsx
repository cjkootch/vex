"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { type ColumnDef } from "@tanstack/react-table";
import { DataTable } from "@/components/data-table/data-table";
import { fetchWithRetry } from "@/lib/fetch-with-retry";

interface CampaignRow {
  id: string;
  channel: string;
  source: string | null;
  medium: string | null;
  accountRef: string | null;
  spend: number | null;
  objective: string | null;
  status: string;
  touchpointCount: number;
  sent: number;
  delivered: number;
  opened: number;
  clicked: number;
  bounced: number;
  createdAt: string;
  updatedAt: string;
}

const STATUS_FILTERS = [
  { label: "All", value: "" },
  { label: "Active", value: "active" },
  { label: "Paused", value: "paused" },
  { label: "Completed", value: "completed" },
  { label: "Archived", value: "archived" },
] as const;

const ASK_VEX_PROMPT =
  "Any campaign anomalies this week? Flag channels with drops in opens or clicks.";

export default function MarketingPage() {
  const [campaigns, setCampaigns] = useState<CampaignRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState<string>("");
  const [createOpen, setCreateOpen] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const qs = statusFilter ? `?status=${encodeURIComponent(statusFilter)}` : "";
    fetchWithRetry(`/api/marketing/campaigns${qs}`, {
      onWaking: () => {
        if (!cancelled) setError("API is waking up…");
      },
    })
      .then(async (res) => {
        if (res.status === 404) {
          throw new Error(
            "apps/api doesn't have /marketing/campaigns yet — redeploy it on Fly.",
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
          typeof body === "object" &&
          body !== null &&
          Array.isArray((body as { campaigns?: unknown }).campaigns)
            ? (body as { campaigns: CampaignRow[] }).campaigns
            : null;
        if (rows === null) {
          setCampaigns([]);
          setError("apps/api returned an unexpected payload.");
          return;
        }
        setCampaigns(rows);
        setError(null);
      })
      .catch((err: Error) => {
        if (!cancelled) {
          setError(err.message);
          setCampaigns([]);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [statusFilter]);

  const columns = useMemo<ColumnDef<CampaignRow, unknown>[]>(
    () => [
      {
        accessorKey: "channel",
        header: "Channel",
        cell: ({ row }) => (
          <Link
            href={`/app/marketing/${row.original.id}`}
            className="font-mono text-accent hover:underline"
            onClick={(e) => e.stopPropagation()}
          >
            {row.original.channel}
          </Link>
        ),
      },
      {
        accessorKey: "source",
        header: "Source",
        cell: ({ getValue }) => getValue<string | null>() ?? "—",
      },
      {
        accessorKey: "medium",
        header: "Medium",
        cell: ({ getValue }) => getValue<string | null>() ?? "—",
      },
      {
        accessorKey: "status",
        header: "Status",
        cell: ({ row }) => <StatusPill status={row.original.status} />,
      },
      {
        accessorKey: "sent",
        header: "Sent",
        cell: ({ getValue }) => formatCount(getValue<number>()),
      },
      {
        accessorKey: "delivered",
        header: "Delivered",
        cell: ({ getValue }) => formatCount(getValue<number>()),
      },
      {
        accessorKey: "opened",
        header: "Opened",
        cell: ({ getValue }) => formatCount(getValue<number>()),
      },
      {
        accessorKey: "clicked",
        header: "Clicked",
        cell: ({ getValue }) => formatCount(getValue<number>()),
      },
      {
        accessorKey: "bounced",
        header: "Bounced",
        cell: ({ getValue }) => formatCount(getValue<number>()),
      },
      {
        accessorKey: "spend",
        header: "Spend",
        cell: ({ getValue }) => formatSpend(getValue<number | null>()),
      },
      {
        accessorKey: "updatedAt",
        header: "Updated",
        cell: ({ getValue }) => shortDate(getValue<string>()),
      },
    ],
    [],
  );

  return (
    <div className="mx-auto flex h-full max-w-6xl flex-col gap-4 px-4 py-4 md:px-6 md:py-6">
      <header className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h1 className="text-xl font-semibold text-white">Marketing</h1>
          <p className="mt-1 hidden text-sm text-white/60 md:block">
            Campaigns with send/open/click rollups from the touchpoint
            stream. Click a row to open campaign detail.
          </p>
        </div>
        <div className="flex flex-shrink-0 items-center gap-2">
          <Link
            href={`/app/chat?ask=${encodeURIComponent(ASK_VEX_PROMPT)}`}
            aria-label="Ask Vex about marketing anomalies"
            className="inline-flex h-9 items-center justify-center rounded-md border border-line px-3 text-sm text-white/80 hover:border-accent hover:text-white"
          >
            <span className="hidden sm:inline">Ask Vex →</span>
            <span className="sm:hidden" aria-hidden="true">
              ✦
            </span>
          </Link>
          <button
            type="button"
            onClick={() => setCreateOpen(true)}
            className="inline-flex h-9 items-center rounded-md bg-accent px-3 text-sm font-medium text-white hover:bg-accent/80"
          >
            + New campaign
          </button>
        </div>
      </header>

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
          Couldn&apos;t load campaigns: {error}
        </div>
      )}

      {campaigns === null ? (
        <div className="rounded-md border border-line bg-muted/20 px-3 py-6 text-center text-sm text-white/40">
          Loading campaigns…
        </div>
      ) : (
        <>
          <div className="md:hidden">
            <CampaignCardList campaigns={campaigns} />
          </div>
          <div className="hidden md:block">
            <DataTable
              data={campaigns}
              columns={columns}
              filterPlaceholder="Filter by channel, source, medium…"
              emptyState="No campaigns match the current filter. Try clearing status."
            />
          </div>
        </>
      )}

      {createOpen && (
        <NewCampaignModal
          onClose={() => setCreateOpen(false)}
          onCreated={(campaign) => {
            setCampaigns((prev) => (prev ? [campaign, ...prev] : [campaign]));
            setCreateOpen(false);
          }}
        />
      )}
    </div>
  );
}

/**
 * Modal form for POST /api/marketing/campaigns. Minimal surface:
 * channel (required) + source/medium/objective (free text). Status
 * defaults to `active` on the server. Submits as JSON; closes on 201
 * and hands the created row back to the page so the list updates
 * optimistically without a full refetch.
 */
function NewCampaignModal({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: (campaign: CampaignRow) => void;
}) {
  const [channel, setChannel] = useState("email");
  const [source, setSource] = useState("");
  const [medium, setMedium] = useState("");
  const [objective, setObjective] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  const submit = async (event: React.FormEvent): Promise<void> => {
    event.preventDefault();
    if (channel.trim().length === 0) {
      setFormError("Channel is required.");
      return;
    }
    setSubmitting(true);
    setFormError(null);
    try {
      const body: Record<string, string> = { channel: channel.trim() };
      if (source.trim()) body["source"] = source.trim();
      if (medium.trim()) body["medium"] = medium.trim();
      if (objective.trim()) body["objective"] = objective.trim();
      const res = await fetch("/api/marketing/campaigns", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const errBody = (await res.json().catch(() => ({}))) as { message?: string };
        throw new Error(
          errBody.message ?? `Create failed: ${res.status} ${res.statusText}`,
        );
      }
      const payload = (await res.json()) as { campaign: CampaignRow };
      onCreated(payload.campaign);
    } catch (err) {
      setFormError((err as Error).message);
      setSubmitting(false);
    }
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="new-campaign-title"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4"
      onClick={onClose}
    >
      <form
        onSubmit={submit}
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-md rounded-lg border border-line bg-canvas p-5 shadow-xl"
      >
        <h2 id="new-campaign-title" className="text-lg font-semibold text-white">
          New campaign
        </h2>
        <p className="mt-1 text-xs text-white/50">
          Creates a campaign record your touchpoints can attribute against.
          All fields except channel are optional.
        </p>

        <div className="mt-4 space-y-3">
          <Field label="Channel" htmlFor="nc-channel" required>
            <input
              id="nc-channel"
              type="text"
              value={channel}
              onChange={(e) => setChannel(e.target.value)}
              placeholder="email, paid_search, outbound, …"
              className="h-9 w-full rounded-md border border-line bg-muted/30 px-3 text-sm text-white focus:border-accent focus:outline-none"
            />
          </Field>
          <Field label="Source" htmlFor="nc-source">
            <input
              id="nc-source"
              type="text"
              value={source}
              onChange={(e) => setSource(e.target.value)}
              placeholder="resend, google_ads, sdr_team"
              className="h-9 w-full rounded-md border border-line bg-muted/30 px-3 text-sm text-white focus:border-accent focus:outline-none"
            />
          </Field>
          <Field label="Medium" htmlFor="nc-medium">
            <input
              id="nc-medium"
              type="text"
              value={medium}
              onChange={(e) => setMedium(e.target.value)}
              placeholder="nurture, cpc, cold_email"
              className="h-9 w-full rounded-md border border-line bg-muted/30 px-3 text-sm text-white focus:border-accent focus:outline-none"
            />
          </Field>
          <Field label="Objective" htmlFor="nc-objective">
            <input
              id="nc-objective"
              type="text"
              value={objective}
              onChange={(e) => setObjective(e.target.value)}
              placeholder="reactivate cold leads"
              className="h-9 w-full rounded-md border border-line bg-muted/30 px-3 text-sm text-white focus:border-accent focus:outline-none"
            />
          </Field>
        </div>

        {formError && (
          <div className="mt-3 rounded-md border border-bad/40 bg-bad/10 px-3 py-2 text-sm text-bad">
            {formError}
          </div>
        )}

        <div className="mt-5 flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="h-9 rounded-md border border-line px-3 text-sm text-white/70 hover:border-accent hover:text-white"
            disabled={submitting}
          >
            Cancel
          </button>
          <button
            type="submit"
            className="h-9 rounded-md bg-accent px-3 text-sm font-medium text-white hover:bg-accent/80 disabled:cursor-not-allowed disabled:opacity-60"
            disabled={submitting}
          >
            {submitting ? "Creating…" : "Create campaign"}
          </button>
        </div>
      </form>
    </div>
  );
}

function Field({
  label,
  htmlFor,
  required,
  children,
}: {
  label: string;
  htmlFor: string;
  required?: boolean;
  children: React.ReactNode;
}) {
  return (
    <label htmlFor={htmlFor} className="block">
      <span className="mb-1 block text-xs uppercase tracking-wider text-white/50">
        {label}
        {required && <span className="ml-0.5 text-accent">*</span>}
      </span>
      {children}
    </label>
  );
}

/**
 * Mobile card list. Shows the campaign ref (source · medium), status
 * pill, and a compact sent/opened/clicked metric row. Tables get
 * unreadable below ~640px.
 */
function CampaignCardList({ campaigns }: { campaigns: CampaignRow[] }) {
  if (campaigns.length === 0) {
    return (
      <div className="rounded-md border border-line bg-muted/20 px-3 py-6 text-center text-sm text-white/40">
        No campaigns match the current filter.
      </div>
    );
  }
  return (
    <ul className="flex flex-col gap-2">
      {campaigns.map((c) => (
        <li key={c.id}>
          <Link
            href={`/app/marketing/${c.id}`}
            className="block rounded-lg border border-line bg-muted/20 p-3 transition-colors hover:border-accent/60 hover:bg-muted/40"
          >
            <div className="flex items-start justify-between gap-2">
              <span className="font-mono text-sm text-accent">
                {campaignRef(c)}
              </span>
              <StatusPill status={c.status} />
            </div>
            {c.objective && (
              <div className="mt-1.5 truncate text-sm text-white/80">
                {c.objective}
              </div>
            )}
            <div className="mt-2 flex items-center gap-4 text-xs text-white/60">
              <Metric label="Sent" value={c.sent} />
              <Metric label="Opened" value={c.opened} />
              <Metric label="Clicked" value={c.clicked} />
            </div>
          </Link>
        </li>
      ))}
    </ul>
  );
}

function Metric({ label, value }: { label: string; value: number }) {
  return (
    <div className="flex items-baseline gap-1">
      <span className="text-sm text-white">{formatCount(value)}</span>
      <span className="text-[10px] uppercase tracking-wide text-white/50">
        {label}
      </span>
    </div>
  );
}

function StatusPill({ status }: { status: string }) {
  const palette: Record<string, string> = {
    active: "bg-good/20 text-good",
    paused: "bg-warn/20 text-warn",
    completed: "bg-muted/80 text-white/60",
    archived: "bg-muted/60 text-white/50",
  };
  return (
    <span
      className={`inline-block rounded px-1.5 py-0.5 text-xs ${
        palette[status] ?? "bg-muted/60 text-white/70"
      }`}
    >
      {status}
    </span>
  );
}

function campaignRef(c: CampaignRow): string {
  const left = c.source ?? c.channel;
  const right = c.medium;
  if (right) return `${left} · ${right}`;
  return left;
}

/**
 * Compact count formatting. Thousands comma under 1000, `12.3k` over
 * 1000. Shared with the detail page's rollup rail.
 */
export function formatCount(n: number | null | undefined): string {
  if (n === null || n === undefined || Number.isNaN(n)) return "—";
  if (n < 1000) return n.toLocaleString("en-US");
  return `${(n / 1000).toFixed(1)}k`;
}

function formatSpend(n: number | null): string {
  if (n === null || n === undefined) return "—";
  if (n === 0) return "$0";
  if (n >= 1000) return `$${(n / 1000).toFixed(1)}k`;
  return `$${n.toLocaleString("en-US")}`;
}

function shortDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const months = [
    "Jan",
    "Feb",
    "Mar",
    "Apr",
    "May",
    "Jun",
    "Jul",
    "Aug",
    "Sep",
    "Oct",
    "Nov",
    "Dec",
  ];
  return `${months[d.getMonth()]} ${d.getDate()}`;
}
