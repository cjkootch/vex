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

interface ProcurApproval {
  status:
    | "pending"
    | "kyc_in_progress"
    | "approved_without_kyc"
    | "approved_with_kyc"
    | "rejected"
    | "expired";
  approvedAt: string | null;
  expiresAt: string | null;
  notes: string | null;
}

interface ProductSpec {
  property: string;
  astmMethod: string | null;
  units: string | null;
  min: string | null;
  max: string | null;
  typical: string | null;
}

interface SourceDocument {
  url: string;
  contentType: string;
  filename: string;
}

interface MarketContext {
  benchmarkAsOf: string | null;
  brentSpotUsdPerBbl: number | null;
  nyhDieselSpotUsdPerGal: number | null;
  nyhGasolineSpotUsdPerGal: number | null;
}

interface ProcurTradingDefaults {
  defaultSourcingRegion: string | null;
  targetGrossMarginPct: number | null;
  targetNetMarginPerUsg: number | null;
  monthlyFixedOverheadUsdDefault: number | null;
}

interface ProcurMetadata {
  procurApproval?: ProcurApproval;
  productSpecs?: ProductSpec[];
  sourceDocuments?: SourceDocument[];
  marketContext?: MarketContext;
  procurTradingDefaults?: ProcurTradingDefaults;
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
  procurMetadata: ProcurMetadata | null;
  procurMetadataAt: string | null;
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
  // ProcurEnrichmentAgent appends `procur:*` tags whenever it
  // hydrates an org from procur (`procur:enriched`,
  // `procur:not_in_database`, `procur:disambiguation_needed`, plus
  // any procur-side tags like `procur:high_award_velocity`). Splitting
  // them into their own row makes the procur lineage scannable
  // without operators having to read every tag.
  const procurTags = tags.filter((t) => t.toLowerCase().startsWith("procur:"));
  const otherTags = tags.filter((t) => !t.toLowerCase().startsWith("procur:"));
  return (
    <div className="space-y-3">
      <OfacControls org={org} onScreenComplete={onRefresh} />

      {procurTags.length > 0 ? (
        <section
          className="flex flex-wrap items-center gap-2 rounded-lg border border-accent/30 bg-accent/5 px-3 py-2 text-xs"
          title="This organization was hydrated from procur — tags below show the procur signals attached to it."
        >
          <ProcurLogo className="h-3.5" />
          <span className="text-white/60">·</span>
          {procurTags.map((tag) => (
            <span
              key={tag}
              className="rounded-full border border-accent/30 bg-accent/10 px-2 py-0.5 text-[11px] text-accent"
            >
              {tag.replace(/^procur:/i, "")}
            </span>
          ))}
        </section>
      ) : null}

      {org.procurMetadata ? (
        <ProcurIntelligencePanel
          metadata={org.procurMetadata}
          asOf={org.procurMetadataAt}
        />
      ) : null}

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
            {otherTags.length === 0 ? (
              "—"
            ) : (
              <span className="flex flex-wrap gap-1.5">
                {otherTags.map((tag) => (
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

/**
 * Procur brand mark. Renders the off-white wordmark over our dark
 * UI; falls back to the dark wordmark when the caller marks it for
 * a light surface (e.g. printable exports). Width auto-sizes from
 * the height set by the caller's class — the light SVG is 1500x608.
 */
function ProcurLogo({
  className,
  variant = "light",
}: {
  className?: string;
  variant?: "light" | "dark";
}) {
  const src =
    variant === "dark" ? "/procur/logo-dark.svg" : "/procur/logo-light.svg";
  // Width auto-scales from the height the caller's class sets — the
  // SVG's intrinsic 1500x608 aspect ratio handles the rest.
  return (
    // eslint-disable-next-line @next/next/no-img-element -- static SVG, no width/height optimisation needed
    <img src={src} alt="Procur" className={`w-auto ${className ?? ""}`} />
  );
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

/**
 * Procur intelligence panel — surfaces the structured sidecar context
 * procur attaches to every push (PR #316). Five sub-sections, each
 * gated on the corresponding sub-object being present:
 *   · KYC / approval state — colored pill + expiry warning
 *   · Source documents — clickable list of Vercel-blob URLs
 *   · Product specs — ASTM table from the user-uploaded datasheet
 *   · Market context — benchmark snapshot at push time
 *   · Trading defaults — pushing desk's profile (region + margin
 *     targets), useful context for outreach drafts
 *
 * Numbers in productSpecs are rendered VERBATIM as strings — spec
 * deviations are material; round-tripping them through `Number`
 * would silently change values.
 */
function ProcurIntelligencePanel({
  metadata,
  asOf,
}: {
  metadata: ProcurMetadata;
  asOf: string | null;
}) {
  const approval = metadata.procurApproval;
  const specs = metadata.productSpecs ?? [];
  const docs = metadata.sourceDocuments ?? [];
  const market = metadata.marketContext;
  const defaults = metadata.procurTradingDefaults;
  const expired =
    approval?.expiresAt && new Date(approval.expiresAt).getTime() < Date.now();
  return (
    <section className="rounded-lg border border-accent/30 bg-accent/5 p-4">
      <header className="mb-3 flex items-center justify-between gap-4">
        <h3 className="flex items-center gap-2 text-sm font-semibold text-accent">
          <ProcurLogo className="h-4" />
          <span>intelligence</span>
        </h3>
        {asOf ? (
          <span className="text-[11px] text-white/50">
            Pushed {new Date(asOf).toLocaleDateString()}
          </span>
        ) : null}
      </header>

      {approval ? (
        <div className="mb-4 flex flex-wrap items-center gap-2 text-xs">
          <span
            className={`rounded-full border px-2 py-0.5 font-medium ${
              approval.status === "approved_with_kyc" ||
              approval.status === "approved_without_kyc"
                ? expired
                  ? "border-warn/50 bg-warn/15 text-warn"
                  : "border-good/50 bg-good/15 text-good"
                : approval.status === "rejected" ||
                    approval.status === "expired"
                  ? "border-bad/50 bg-bad/15 text-bad"
                  : "border-line bg-white/5 text-white/70"
            }`}
            title={
              approval.notes ??
              `Procur-side KYC / approval state: ${approval.status}`
            }
          >
            {approvalLabel(approval.status, expired)}
          </span>
          {approval.expiresAt ? (
            <span className="text-[11px] text-white/50">
              {expired ? "Expired" : "Expires"}{" "}
              {new Date(approval.expiresAt).toLocaleDateString()}
            </span>
          ) : null}
          {approval.notes ? (
            <p className="basis-full text-[11px] text-white/60">
              {approval.notes}
            </p>
          ) : null}
        </div>
      ) : null}

      {docs.length > 0 ? (
        <div className="mb-4">
          <div className="mb-1.5 text-[10px] uppercase tracking-wider text-white/40">
            Source documents
          </div>
          <ul className="flex flex-col gap-1">
            {docs.map((d) => (
              <li key={d.url}>
                <a
                  href={d.url}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex items-center gap-2 text-xs text-accent hover:text-accent-strong hover:underline"
                >
                  <span aria-hidden>📎</span>
                  <span className="font-mono">{d.filename}</span>
                  <span className="text-[10px] text-white/40">
                    {d.contentType.replace(/^application\//, "")}
                  </span>
                </a>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {specs.length > 0 ? (
        <div className="mb-4">
          <div className="mb-1.5 text-[10px] uppercase tracking-wider text-white/40">
            Product specs (verbatim from datasheet)
          </div>
          <div className="overflow-x-auto rounded-md border border-line/40">
            <table className="w-full text-xs">
              <thead className="bg-white/5 text-white/60">
                <tr>
                  <th className="px-2 py-1 text-left font-normal">Property</th>
                  <th className="px-2 py-1 text-left font-normal">Method</th>
                  <th className="px-2 py-1 text-right font-normal">Min</th>
                  <th className="px-2 py-1 text-right font-normal">Max</th>
                  <th className="px-2 py-1 text-right font-normal">Typical</th>
                  <th className="px-2 py-1 text-left font-normal">Units</th>
                </tr>
              </thead>
              <tbody className="text-white/80">
                {specs.map((s, i) => (
                  <tr key={i} className="border-t border-line/30">
                    <td className="px-2 py-1">{s.property}</td>
                    <td className="px-2 py-1 font-mono text-[11px] text-white/60">
                      {s.astmMethod ?? "—"}
                    </td>
                    <td className="px-2 py-1 text-right font-mono">
                      {s.min ?? "—"}
                    </td>
                    <td className="px-2 py-1 text-right font-mono">
                      {s.max ?? "—"}
                    </td>
                    <td className="px-2 py-1 text-right font-mono">
                      {s.typical ?? "—"}
                    </td>
                    <td className="px-2 py-1 text-[11px] text-white/60">
                      {s.units ?? ""}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      ) : null}

      {market || defaults ? (
        <div className="grid gap-3 sm:grid-cols-2">
          {market ? (
            <div>
              <div className="mb-1.5 text-[10px] uppercase tracking-wider text-white/40">
                Market context
                {market.benchmarkAsOf
                  ? ` · ${new Date(market.benchmarkAsOf).toLocaleDateString()}`
                  : ""}
              </div>
              <ul className="space-y-0.5 text-xs">
                {market.brentSpotUsdPerBbl != null && (
                  <li className="flex justify-between">
                    <span className="text-white/60">Brent spot</span>
                    <span className="font-mono">
                      ${market.brentSpotUsdPerBbl.toFixed(2)}/bbl
                    </span>
                  </li>
                )}
                {market.nyhDieselSpotUsdPerGal != null && (
                  <li className="flex justify-between">
                    <span className="text-white/60">NYH diesel</span>
                    <span className="font-mono">
                      ${market.nyhDieselSpotUsdPerGal.toFixed(4)}/gal
                    </span>
                  </li>
                )}
                {market.nyhGasolineSpotUsdPerGal != null && (
                  <li className="flex justify-between">
                    <span className="text-white/60">NYH gasoline</span>
                    <span className="font-mono">
                      ${market.nyhGasolineSpotUsdPerGal.toFixed(4)}/gal
                    </span>
                  </li>
                )}
              </ul>
            </div>
          ) : null}
          {defaults ? (
            <div>
              <div className="mb-1.5 text-[10px] uppercase tracking-wider text-white/40">
                Pushing desk defaults
              </div>
              <ul className="space-y-0.5 text-xs">
                {defaults.defaultSourcingRegion && (
                  <li className="flex justify-between">
                    <span className="text-white/60">Region</span>
                    <span className="font-mono uppercase">
                      {defaults.defaultSourcingRegion}
                    </span>
                  </li>
                )}
                {defaults.targetGrossMarginPct != null && (
                  <li className="flex justify-between">
                    <span className="text-white/60">Gross margin target</span>
                    <span className="font-mono">
                      {(defaults.targetGrossMarginPct * 100).toFixed(1)}%
                    </span>
                  </li>
                )}
                {defaults.targetNetMarginPerUsg != null && (
                  <li className="flex justify-between">
                    <span className="text-white/60">Net per USG</span>
                    <span className="font-mono">
                      ${defaults.targetNetMarginPerUsg.toFixed(4)}
                    </span>
                  </li>
                )}
                {defaults.monthlyFixedOverheadUsdDefault != null && (
                  <li className="flex justify-between">
                    <span className="text-white/60">Monthly overhead</span>
                    <span className="font-mono">
                      ${defaults.monthlyFixedOverheadUsdDefault.toLocaleString()}
                    </span>
                  </li>
                )}
              </ul>
            </div>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}

function approvalLabel(
  status: ProcurApproval["status"],
  expired: boolean | null | "" | undefined,
): string {
  if (expired) return "✗ KYC expired";
  switch (status) {
    case "approved_with_kyc":
      return "✓ Procur KYC'd";
    case "approved_without_kyc":
      return "✓ Procur approved";
    case "kyc_in_progress":
      return "⋯ KYC in progress";
    case "pending":
      return "⋯ Procur review pending";
    case "rejected":
      return "✗ Rejected by procur";
    case "expired":
      return "✗ Procur approval expired";
    default:
      return status;
  }
}
