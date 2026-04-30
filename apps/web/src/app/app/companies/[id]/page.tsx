"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { ActivityTimeline } from "@/components/activity/activity-timeline";
import { DocumentsPanel } from "@/components/documents/documents-panel";
import { OrgProductsPanel } from "@/components/crm/org-products-panel";
import { OrgRelationshipsPanel } from "@/components/crm/org-relationships-panel";
import { QuickActions } from "@/components/crm/quick-actions";
import { SignalsPanel } from "@/components/signals/signals-panel";
import { EditCompanyForm } from "@/components/crm/edit-company-form";
import { Tabs } from "@/components/ui/tabs";
import { AskVexButton } from "@/components/shell/ask-vex-button";
import { CompanyHero } from "@/components/profile/company-hero";
import { fetchWithRetry } from "@/lib/fetch-with-retry";

interface OrganizationContact {
  id: string;
  fullName: string;
  title: string | null;
  email: string | null;
  phone: string | null;
  optedOut: boolean;
}

interface OrganizationDeal {
  id: string;
  dealRef: string;
  status: string;
  product: string;
  volumeUsg: number;
  role: "buyer" | "seller";
}

interface OrganizationNote {
  body: string;
  createdAt: string;
}

interface OrganizationDetail {
  id: string;
  legalName: string;
  domain: string | null;
  industry: string | null;
  fitScore: number | null;
  status: string;
  sourceOfTruth: string | null;
  externalKeys: Record<string, string>;
  contactCount: number;
  tags: string[];
  kind: string | null;
  country: string | null;
  ofacStatus: string;
  ofacScreenedAt: string | null;
  notes: OrganizationNote[];
  createdAt: string;
  updatedAt: string;
  contacts: OrganizationContact[];
  deals: OrganizationDeal[];
}

export default function CompanyDetailPage({
  params,
}: {
  params: { id: string };
}) {
  const [org, setOrg] = useState<OrganizationDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState("overview");
  const [refreshKey, setRefreshKey] = useState(0);
  const [editOpen, setEditOpen] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setOrg(null);
    fetch(`/api/organizations/${params.id}`)
      .then(async (res) => {
        if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
        return res.json();
      })
      .then((body: { organization: OrganizationDetail }) => {
        if (!cancelled) {
          setOrg({
            ...body.organization,
            deals: body.organization.deals ?? [],
            contacts: body.organization.contacts ?? [],
          });
          setError(null);
        }
      })
      .catch((err: Error) => {
        if (!cancelled) setError(err.message);
      });
    return () => {
      cancelled = true;
    };
  }, [params.id, refreshKey]);

  if (error) {
    return (
      <div className="mx-auto max-w-3xl px-6 py-8">
        <Breadcrumb name={null} />
        <div className="mt-4 rounded-md border border-bad/40 bg-bad/10 px-3 py-2 text-sm text-bad">
          Couldn&apos;t load company: {error}
        </div>
      </div>
    );
  }

  if (!org) {
    return (
      <div className="mx-auto max-w-3xl px-6 py-8">
        <Breadcrumb name={null} />
        <div className="mt-4 text-sm text-white/40">Loading company…</div>
      </div>
    );
  }

  return (
    <div className="mx-auto flex max-w-5xl flex-col gap-6 px-6 py-6">
      <Breadcrumb name={org.legalName} />

      <CompanyHero
        orgId={org.id}
        fallback={{
          legalName: org.legalName,
          domain: org.domain ?? null,
          industry: org.industry ?? null,
          fitScore: org.fitScore ?? null,
        }}
        actions={
          <>
            <button
              type="button"
              onClick={() => setEditOpen(true)}
              className="rounded-md border border-line-soft bg-surface-2/60 px-3 py-1.5 text-sm text-text-secondary transition-colors hover:border-line-strong hover:text-text-primary"
            >
              Edit
            </button>
          <AskVexButton
            type="organization"
            id={org.id}
            label={org.legalName}
            defaultAsk={`Tell me about ${org.legalName}`}
            actions={[
              {
                label: "Counterparty snapshot",
                ask: `Give me a snapshot of ${org.legalName}: OFAC status, open deals, recent touchpoints, key contacts, any risk signals.`,
                hint: "OFAC + deals + people at a glance",
              },
              {
                label: "Research & enrich",
                ask: `Research ${org.legalName}: ownership, counterparty risk, leadership, public news, anything relevant to trading with them.`,
              },
              {
                label: "Draft outreach",
                ask: `Draft a short intro email to the right person at ${org.legalName} — use what we already know about them.`,
              },
              {
                label: "List their deals",
                ask: `Show me every deal involving ${org.legalName} — buyer, supplier, or broker side — with status and value.`,
              },
              {
                label: "Re-screen OFAC",
                ask: `Re-run OFAC screening on ${org.legalName} and tell me if anything changed.`,
              },
            ]}
          />
          </>
        }
      />

      <QuickActions
        items={[
          {
            label: "Email",
            ask: `Draft an email to ${org.legalName}`,
          },
          {
            label: "Add contact",
            ask: `Add a contact at ${org.legalName}: `,
          },
          {
            label: "Create deal",
            ask: `Create a new deal with ${org.legalName} as the buyer: `,
          },
          {
            label: "Tag product",
            ask: `Tag ${org.legalName} with a product: `,
          },
          {
            label: "Add note",
            ask: `Add a note on ${org.legalName}: `,
          },
        ]}
      />

      <SignalsPanel subjectType="organization" subjectId={org.id} />

      <EditCompanyForm
        open={editOpen}
        organization={org}
        onClose={() => setEditOpen(false)}
        onSaved={() => setRefreshKey((k) => k + 1)}
      />

      <Tabs
        active={activeTab}
        onChange={setActiveTab}
        tabs={[
          {
            id: "overview",
            label: "Overview",
            content: (
              <OverviewTab
                org={org}
                onRefresh={() => setRefreshKey((k) => k + 1)}
              />
            ),
          },
          {
            id: "contacts",
            label: "Contacts",
            count: org.contacts.length,
            content: <ContactsTab contacts={org.contacts} />,
          },
          {
            id: "deals",
            label: "Deals",
            count: org.deals.length,
            content: <DealsTab deals={org.deals} />,
          },
          {
            id: "products",
            label: "Products",
            content: <OrgProductsPanel orgId={org.id} />,
          },
          {
            id: "relationships",
            label: "Relationships",
            content: <OrgRelationshipsPanel orgId={org.id} />,
          },
          {
            id: "documents",
            label: "Documents",
            content: (
              <DocumentsPanel subjectType="organization" subjectId={org.id} />
            ),
          },
          {
            id: "activity",
            label: "Activity",
            content: (
              <ActivityTimeline subjectType="organization" subjectId={org.id} />
            ),
          },
        ]}
      />
    </div>
  );
}

function OverviewTab({
  org,
  onRefresh,
}: {
  org: OrganizationDetail;
  onRefresh: () => void;
}) {
  const tags = org.tags ?? [];
  const notes = org.notes ?? [];
  return (
    <div className="space-y-3">
      <OfacControls org={org} onScreenComplete={onRefresh} />

      <section className="rounded-lg border border-line bg-muted/20 p-4">
        <div className="grid grid-cols-[140px_1fr] gap-2 text-sm">
          <span className="text-white/50">Status</span>
          <span className="text-white/90">{org.status}</span>
          <span className="text-white/50">Kind</span>
          <span className="text-white/90">
            {org.kind ? <KindBadge kind={org.kind} /> : "—"}
          </span>
          <span className="text-white/50">Country</span>
          <span className="text-white/90">{org.country ?? "—"}</span>
          <span className="text-white/50">Domain</span>
          <span className="text-white/90">{org.domain ?? "—"}</span>
          <span className="text-white/50">Industry</span>
          <span className="text-white/90">{org.industry ?? "—"}</span>
          <span className="text-white/50">Source</span>
          <span className="text-white/90">{org.sourceOfTruth ?? "—"}</span>
          <span className="text-white/50">Tags</span>
          <span className="text-white/90">
            {tags.length === 0 ? (
              "—"
            ) : (
              <span className="flex flex-wrap gap-1.5">
                {tags.map((tag) => (
                  <span
                    key={tag}
                    className="rounded-full bg-accent/15 px-2 py-0.5 text-xs text-accent"
                  >
                    {tag}
                  </span>
                ))}
              </span>
            )}
          </span>
          <span className="text-white/50">External keys</span>
          <span className="font-mono text-xs text-white/90">
            {Object.keys(org.externalKeys).length === 0
              ? "—"
              : Object.entries(org.externalKeys)
                  .map(([k, v]) => `${k}: ${v}`)
                  .join(", ")}
          </span>
        </div>
      </section>

      {notes.length > 0 ? (
        <section className="rounded-lg border border-line bg-muted/20 p-4">
          <h3 className="mb-2 text-eyebrow text-text-muted">Research notes</h3>
          <div className="space-y-3">
            {notes.map((n, i) => (
              <article
                key={`${n.createdAt}-${i}`}
                className="border-l-2 border-accent/40 pl-3 text-sm text-white/85"
              >
                <p className="whitespace-pre-wrap">{n.body}</p>
                <p className="mt-1 text-xs text-text-muted">
                  {new Date(n.createdAt).toLocaleString()}
                </p>
              </article>
            ))}
          </div>
        </section>
      ) : null}
    </div>
  );
}

function KindBadge({ kind }: { kind: string }) {
  return (
    <span className="rounded-full border border-line-soft bg-surface-2/60 px-2 py-0.5 text-xs uppercase tracking-wider text-white/80">
      {kind}
    </span>
  );
}

/**
 * OFAC controls panel — only visible when the org hasn't been
 * screened yet (or the operator just queued a re-screen). Once a
 * status lands, the panel hides itself and the export action moves
 * inline with the OFAC badge in the page header (CompanyHero).
 *
 * Queue → poll loop:
 *   1. Operator clicks Run → POST /ofac/screen, gets 202.
 *   2. We start polling /api/organizations/:id every 3s for up to
 *      90s, watching for ofacScreenedAt to advance past the "before
 *      I queued" timestamp.
 *   3. When it advances, the parent's onScreenComplete callback
 *      bumps the page's refreshKey — full org refetch, this panel
 *      unmounts because ofacStatus is no longer "unscreened".
 *
 * Display shows elapsed seconds during the poll so operators see
 * something is happening (auto-stop on the worker means cold-start
 * up to 30s; warm worker should resolve in 5-10s).
 */
function OfacControls({
  org,
  onScreenComplete,
}: {
  org: OrganizationDetail;
  onScreenComplete: () => void;
}) {
  const [runState, setRunState] = useState<
    "idle" | "running" | "polling" | "error"
  >("idle");
  const [runError, setRunError] = useState<string | null>(null);
  const [elapsedSec, setElapsedSec] = useState(0);

  // Hide the panel entirely once the org has any non-unscreened
  // status — operator uses the inline export button in the header
  // from then on. "Re-screen" is also handled there.
  if (org.ofacStatus && org.ofacStatus !== "unscreened" && runState === "idle") {
    return null;
  }

  const runScreen = async (): Promise<void> => {
    const queuedAtIso = new Date().toISOString();
    setRunState("running");
    setRunError(null);
    try {
      const res = await fetchWithRetry(
        `/api/organizations/${org.id}/ofac/screen`,
        { method: "POST" },
      );
      if (!res.ok && res.status !== 202) {
        throw new Error(`${res.status} ${res.statusText}`);
      }
      setRunState("polling");
      setElapsedSec(0);
      // Poll for up to 90s. The OFAC agent typically resolves in
      // 5-30s; the upper bound is for cold-start cases. After 90s
      // we give up on the live update — operator can refresh
      // manually if curious.
      const start = Date.now();
      const timer = setInterval(() => {
        setElapsedSec(Math.floor((Date.now() - start) / 1000));
      }, 500);
      const startedAt = new Date(queuedAtIso).getTime();
      const tryPoll = async (): Promise<boolean> => {
        const r = await fetch(`/api/organizations/${org.id}`);
        if (!r.ok) return false;
        const body = (await r.json()) as { organization?: OrganizationDetail };
        const screened = body.organization?.ofacScreenedAt;
        if (screened && new Date(screened).getTime() > startedAt) return true;
        return false;
      };
      const deadline = Date.now() + 90_000;
      while (Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 3000));
        if (await tryPoll()) {
          clearInterval(timer);
          setRunState("idle");
          setElapsedSec(0);
          onScreenComplete();
          return;
        }
      }
      clearInterval(timer);
      setRunState("error");
      setRunError(
        "Screen didn't complete within 90s. Worker may be cold-starting — refresh in a minute to see the result.",
      );
    } catch (err) {
      setRunState("error");
      setRunError((err as Error).message);
    }
  };

  return (
    <section className="rounded-lg border border-line bg-muted/20 p-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h3 className="text-sm font-medium text-white/90">OFAC screening</h3>
          <p className="mt-0.5 text-xs text-white/60">
            This counterparty hasn&apos;t been screened against the SDN list
            yet. Run a screen before transacting.
          </p>
        </div>
        <button
          type="button"
          onClick={runScreen}
          disabled={runState === "running" || runState === "polling"}
          className="inline-flex items-center gap-2 rounded-md border border-line-soft bg-surface-2/60 px-3 py-1.5 text-xs text-white/85 transition-colors hover:border-accent hover:text-white disabled:opacity-60"
        >
          {runState === "running" ? (
            <>
              <Spinner /> Queueing…
            </>
          ) : runState === "polling" ? (
            <>
              <Spinner /> Screening… {elapsedSec}s
            </>
          ) : (
            "Run OFAC screen"
          )}
        </button>
      </div>
      {runError ? (
        <p className="mt-2 text-xs text-bad">{runError}</p>
      ) : null}
    </section>
  );
}

function Spinner() {
  return (
    <span
      aria-hidden
      className="inline-block h-3 w-3 animate-spin rounded-full border-2 border-white/30 border-t-white/80"
    />
  );
}

function ContactsTab({ contacts }: { contacts: OrganizationContact[] }) {
  if (contacts.length === 0) {
    return (
      <p className="rounded-md border border-line bg-muted/20 px-3 py-4 text-sm text-white/50">
        No contacts at this company yet.
      </p>
    );
  }
  return (
    <ul className="flex flex-col divide-y divide-line/60 rounded-lg border border-line bg-muted/20 px-4">
      {contacts.map((c) => (
        <li
          key={c.id}
          className="flex items-start justify-between py-3 text-sm"
        >
          <div>
            <Link
              href={`/app/contacts/${c.id}`}
              className="font-medium text-accent hover:underline"
            >
              {c.fullName}
            </Link>
            <div className="text-xs text-white/50">
              {c.title ?? "—"} · {c.email ?? "no email"}
            </div>
          </div>
          {c.optedOut && (
            <span className="rounded bg-bad/20 px-1.5 py-0.5 text-xs text-bad">
              suppressed
            </span>
          )}
        </li>
      ))}
    </ul>
  );
}

function DealsTab({ deals }: { deals: OrganizationDeal[] }) {
  if (deals.length === 0) {
    return (
      <p className="rounded-md border border-line bg-muted/20 px-3 py-4 text-sm text-white/50">
        No deals linked to this company yet.
      </p>
    );
  }
  return (
    <ul className="flex flex-col divide-y divide-line/60 rounded-lg border border-line bg-muted/20 px-4">
      {deals.map((d) => (
        <li
          key={d.id}
          className="flex items-start justify-between py-3 text-sm"
        >
          <div>
            <Link
              href={`/app/deals/${d.id}`}
              className="font-mono font-medium text-accent hover:underline"
            >
              {d.dealRef}
            </Link>
            <div className="text-xs text-white/50">
              {d.product} · {formatVolume(d.volumeUsg)} · as {d.role}
            </div>
          </div>
          <span className="rounded bg-muted/60 px-1.5 py-0.5 text-xs text-white/70">
            {d.status.replace(/_/g, " ")}
          </span>
        </li>
      ))}
    </ul>
  );
}

function formatVolume(usg: number): string {
  if (usg >= 1_000_000) return `${(usg / 1_000_000).toFixed(1)}M USG`;
  if (usg >= 1_000) return `${(usg / 1_000).toFixed(0)}k USG`;
  return `${usg} USG`;
}

function Breadcrumb({ name }: { name: string | null }) {
  return (
    <nav className="text-xs text-white/50">
      <Link href="/app" className="hover:text-white/80">
        Home
      </Link>
      <span className="mx-1">/</span>
      <Link href="/app/companies" className="hover:text-white/80">
        Companies
      </Link>
      {name && (
        <>
          <span className="mx-1">/</span>
          <span className="text-white/70">{name}</span>
        </>
      )}
    </nav>
  );
}
