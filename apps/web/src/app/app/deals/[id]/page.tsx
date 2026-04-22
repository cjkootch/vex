"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { ActivityTimeline } from "@/components/activity/activity-timeline";
import { DocumentsPanel } from "@/components/documents/documents-panel";
import { DealStatusMenu } from "@/components/crm/deal-status-menu";
import { QuickActions } from "@/components/crm/quick-actions";
import { SignalsPanel } from "@/components/signals/signals-panel";
import { EditDealForm } from "@/components/crm/edit-deal-form";
import { VesselPanel } from "@/components/deals/vessel-panel";
import { PortPanel } from "@/components/deals/port-panel";
import { ReadinessPanel } from "@/components/deals/readiness-panel";
import { ReadinessPill } from "@/components/deals/readiness-pill";
import { Tabs } from "@/components/ui/tabs";
import { AskVexButton } from "@/components/shell/ask-vex-button";

interface DealDetail {
  id: string;
  dealRef: string;
  status: string;
  product: string;
  buyerOrgId: string;
  buyerName: string | null;
  sellerOrgId: string | null;
  sellerName: string | null;
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
  paymentTerms: string;
  currency: string;
  originPort: string | null;
  destinationPort: string | null;
  notes: string | null;
  createdAt: string;
  updatedAt: string;
  latestScenario: {
    id: string;
    scenarioName: string;
    scenarioType: string;
    isActive: boolean;
    score: number | null;
    recommendation: string | null;
    resultsJson: unknown;
  } | null;
}

export default function DealDetailPage({ params }: { params: { id: string } }) {
  const [deal, setDeal] = useState<DealDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const searchParams = useSearchParams();
  const initialTab = searchParams?.get("tab") ?? "overview";
  const [activeTab, setActiveTab] = useState(initialTab);
  const [editOpen, setEditOpen] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setDeal(null);
    fetch(`/api/deals/${params.id}`)
      .then(async (res) => {
        if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
        return res.json();
      })
      .then((body: { deal: DealDetail }) => {
        if (!cancelled) {
          setDeal(body.deal);
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
        <Breadcrumb dealRef={null} />
        <div className="mt-4 rounded-md border border-bad/40 bg-bad/10 px-3 py-2 text-sm text-bad">
          Couldn&apos;t load deal: {error}
        </div>
      </div>
    );
  }

  if (!deal) {
    return (
      <div className="mx-auto max-w-3xl px-6 py-8">
        <Breadcrumb dealRef={null} />
        <div className="mt-4 text-sm text-white/40">Loading deal…</div>
      </div>
    );
  }

  return (
    <div className="mx-auto flex max-w-5xl flex-col gap-6 px-6 py-6">
      <Breadcrumb dealRef={deal.dealRef} />

      <header className="flex items-start justify-between gap-4">
        <div>
          <div className="flex items-center gap-3">
            <h1 className="font-mono text-2xl text-white">{deal.dealRef}</h1>
            <StatusPill status={deal.status} />
            <ReadinessPill dealId={deal.id} />
            {deal.complianceHold && (
              <span className="rounded bg-bad/20 px-2 py-0.5 text-xs text-bad">
                compliance hold
              </span>
            )}
          </div>
          <p className="mt-1 text-sm text-white/60">
            {PRODUCT_LABELS[deal.product] ?? deal.product} · {formatVolume(deal.volumeUsg)} · {deal.buyerName ?? deal.buyerOrgId}
          </p>
        </div>

        <div className="flex items-center gap-2">
          <DealStatusMenu
            dealId={deal.id}
            dealRef={deal.dealRef}
            currentStatus={deal.status}
            onChanged={() => setRefreshKey((k) => k + 1)}
            onApprovalRequested={() => {
              /* toast handled elsewhere */
            }}
          />
          <button
            type="button"
            onClick={() => setEditOpen(true)}
            className="rounded-md border border-line px-3 py-1.5 text-sm text-white/80 hover:border-accent hover:text-white"
          >
            Edit
          </button>
          <AskVexButton
            type="deal"
            id={deal.id}
            label={deal.dealRef}
            defaultAsk={`Score deal ${deal.dealRef}`}
            actions={[
              {
                label: "Score this deal",
                ask: `Score deal ${deal.dealRef} and explain the EBITDA / margin drivers.`,
                hint: "Runs the deal evaluator + surfaces the flags",
              },
              {
                label: "Check readiness to ship",
                ask: `For deal ${deal.dealRef}, walk me through KYC, OFAC, counterparty approval, freight freshness, vessel, payment terms, docs, and next milestone owner. Tell me what's blocking.`,
                hint: "KYC → OFAC → vessel → docs → next step",
              },
              {
                label: "Draft buyer update",
                ask: `Draft a short status update email to the buyer on deal ${deal.dealRef} covering laycan, vessel, and next milestone.`,
              },
              {
                label: "Summarise recent activity",
                ask: `Summarise the last 14 days of activity on deal ${deal.dealRef} — calls, emails, milestones, any blockers.`,
              },
              {
                label: "Research the buyer",
                ask: `Tell me what you know about the buyer on deal ${deal.dealRef}: open deals, recent touchpoints, OFAC status, any risk signals.`,
              },
            ]}
          />
        </div>
      </header>

      <QuickActions
        items={[
          {
            label: "Email buyer",
            ask: `Draft an email to the buyer on deal ${deal.dealRef}`,
          },
          {
            label: "Schedule follow-up",
            ask: `Remind me about deal ${deal.dealRef}`,
          },
          {
            label: "Add note",
            ask: `Add a note on deal ${deal.dealRef}: `,
          },
          {
            label: "Record milestone",
            ask: `Record a milestone on deal ${deal.dealRef}: `,
          },
        ]}
      />

      <SignalsPanel subjectType="fuel_deal" subjectId={deal.id} />

      <EditDealForm
        open={editOpen}
        deal={deal}
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
            content: <OverviewTab deal={deal} />,
          },
          {
            id: "readiness",
            label: "Readiness",
            content: (
              <ReadinessPanel dealId={deal.id} dealRef={deal.dealRef} />
            ),
          },
          {
            id: "documents",
            label: "Documents",
            content: (
              <DocumentsPanel subjectType="fuel_deal" subjectId={deal.id} />
            ),
          },
          {
            id: "activity",
            label: "Activity",
            content: (
              <ActivityTimeline subjectType="fuel_deal" subjectId={deal.id} />
            ),
          },
        ]}
      />
    </div>
  );
}

function OverviewTab({ deal }: { deal: DealDetail }) {
  return (
    <div className="flex flex-col gap-4">
      <PulseCard deal={deal} />
      <VesselPanel dealId={deal.id} />
      <PortPanel dealId={deal.id} />
      <RelatedRecordsCard deal={deal} />
      <Card title="Terms">
        <Field label="Incoterm" value={deal.incoterm.toUpperCase()} />
        <Field label="Payment" value={humanize(deal.paymentTerms)} />
        <Field label="Currency" value={deal.currency.toUpperCase()} />
        <Field label="Origin" value={deal.originPort ?? "—"} />
        <Field label="Destination" value={deal.destinationPort ?? "—"} />
        <Field
          label="Laycan"
          value={formatLaycan(deal.laycanStart, deal.laycanEnd)}
        />
      </Card>

      <Card title="Parties">
        <FieldLink
          label="Buyer"
          href={`/app/companies/${deal.buyerOrgId}`}
          text={deal.buyerName ?? deal.buyerOrgId}
        />
        {deal.sellerOrgId ? (
          <FieldLink
            label="Seller"
            href={`/app/companies/${deal.sellerOrgId}`}
            text={deal.sellerName ?? deal.sellerOrgId}
          />
        ) : (
          <Field label="Seller" value="—" />
        )}
        <Field
          label="OFAC screening"
          value={humanize(deal.ofacStatus)}
          tone={deal.ofacStatus === "cleared" ? "good" : "warn"}
        />
      </Card>

      {deal.notes && (
        <Card title="Notes">
          <p className="text-sm text-white/80 whitespace-pre-line">
            {deal.notes}
          </p>
        </Card>
      )}

      {deal.latestScenario && (
        <Card title={`Latest scenario · ${deal.latestScenario.scenarioName}`}>
          <Field
            label="Score"
            value={
              deal.latestScenario.score !== null
                ? `${Math.round(deal.latestScenario.score)}/100`
                : "not yet scored"
            }
          />
          {(() => {
            const tone = scoreTone(deal.latestScenario.recommendation);
            return (
              <Field
                label="Recommendation"
                value={deal.latestScenario.recommendation ?? "—"}
                {...(tone ? { tone } : {})}
              />
            );
          })()}
        </Card>
      )}
    </div>
  );
}

function Breadcrumb({ dealRef }: { dealRef: string | null }) {
  return (
    <nav className="text-xs text-white/50">
      <Link href="/app" className="hover:text-white/80">
        Home
      </Link>
      <span className="mx-1">/</span>
      <Link href="/app/deals" className="hover:text-white/80">
        Deals
      </Link>
      {dealRef && (
        <>
          <span className="mx-1">/</span>
          <span className="font-mono text-white/70">{dealRef}</span>
        </>
      )}
    </nav>
  );
}

function Card({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="rounded-lg border border-line bg-muted/20 p-4">
      <h3 className="mb-3 text-sm font-semibold uppercase tracking-wide text-white/50">
        {title}
      </h3>
      <div className="flex flex-col gap-2">{children}</div>
    </section>
  );
}

function Field({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone?: "good" | "warn" | "bad";
}) {
  const toneClass =
    tone === "good"
      ? "text-good"
      : tone === "warn"
        ? "text-warn"
        : tone === "bad"
          ? "text-bad"
          : "text-white/90";
  return (
    <div className="grid grid-cols-[120px_1fr] gap-3 text-sm">
      <span className="text-white/50">{label}</span>
      <span className={toneClass}>{value}</span>
    </div>
  );
}

function FieldLink({
  label,
  href,
  text,
}: {
  label: string;
  href: string;
  text: string;
}) {
  return (
    <div className="grid grid-cols-[120px_1fr] gap-3 text-sm">
      <span className="text-white/50">{label}</span>
      <Link href={href} className="text-accent hover:underline">
        {text}
      </Link>
    </div>
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
      className={`inline-block rounded px-2 py-0.5 text-xs ${
        palette[status] ?? "bg-muted/60 text-white/70"
      }`}
    >
      {humanize(status)}
    </span>
  );
}

const PRODUCT_LABELS: Record<string, string> = {
  ulsd: "ULSD",
  jet_a1: "Jet A1",
  jet_a: "Jet A",
  gasoline_87: "Gasoline 87",
  gasoline_91: "Gasoline 91",
  avgas: "Avgas",
  lfo: "LFO",
  hfo: "HFO",
  lng: "LNG",
  lpg: "LPG",
  biodiesel_b20: "Biodiesel B20",
};

function humanize(s: string): string {
  return s.replace(/_/g, " ");
}

function formatVolume(usg: number): string {
  if (usg >= 1_000_000) return `${(usg / 1_000_000).toFixed(1)}M USG`;
  if (usg >= 1_000) return `${(usg / 1_000).toFixed(0)}k USG`;
  return `${usg} USG`;
}

function formatLaycan(start: string | null, end: string | null): string {
  if (!start) return "—";
  if (!end) return start;
  if (start === end) return start;
  return `${start} → ${end}`;
}

function scoreTone(
  rec: string | null,
): "good" | "warn" | "bad" | undefined {
  if (!rec) return undefined;
  if (rec === "acceptable" || rec === "strong") return "good";
  if (rec === "marginal") return "warn";
  if (rec === "do_not_proceed") return "bad";
  return undefined;
}

// ---------------------------------------------------------------------------
// Pulse — compact at-a-glance strip above the Overview card stack. Four
// metrics pulled from the already-loaded deal object (no extra API
// calls): days to laycan, gross margin (when a scenario has landed),
// compliance status, cold-chain flag or BIS flag depending on the LoB.
// ---------------------------------------------------------------------------

function PulseCard({ deal }: { deal: DealDetail }) {
  const daysToLaycan = (() => {
    if (!deal.laycanEnd) return null;
    const end = new Date(deal.laycanEnd);
    if (Number.isNaN(end.getTime())) return null;
    const now = new Date();
    const ms = end.getTime() - now.getTime();
    return Math.round(ms / (24 * 60 * 60 * 1000));
  })();

  const margin = (() => {
    const r = deal.latestScenario?.resultsJson as
      | { totals?: { grossMarginPct?: number } }
      | null
      | undefined;
    const pct = r?.totals?.grossMarginPct;
    if (typeof pct !== "number") return null;
    return pct;
  })();

  const complianceTone =
    deal.complianceHold || deal.ofacStatus !== "cleared" ? "bad" : "good";
  const complianceLabel = deal.complianceHold
    ? "Hold"
    : deal.ofacStatus === "cleared"
      ? "Clear"
      : deal.ofacStatus.replace(/_/g, " ");

  const food = deal.lineOfBusiness === "food";
  const tiles: Array<{
    label: string;
    value: string;
    tone: "neutral" | "good" | "warn" | "bad";
    hint?: string;
  }> = [
    {
      label: "Days to laycan",
      value: daysToLaycan === null ? "—" : String(daysToLaycan),
      tone:
        daysToLaycan === null
          ? "neutral"
          : daysToLaycan < 0
            ? "bad"
            : daysToLaycan < 5
              ? "warn"
              : "good",
      hint: deal.laycanEnd
        ? new Date(deal.laycanEnd).toISOString().slice(0, 10)
        : "unset",
    },
    {
      label: food ? "Production lead" : "Gross margin",
      value: food
        ? deal.productionLeadTimeWeeks !== null &&
          deal.productionLeadTimeWeeks !== undefined
          ? `${deal.productionLeadTimeWeeks}w`
          : "—"
        : margin === null
          ? "—"
          : `${(margin * 100).toFixed(1)}%`,
      tone:
        food
          ? "neutral"
          : margin === null
            ? "neutral"
            : margin < 0.02
              ? "bad"
              : margin < 0.05
                ? "warn"
                : "good",
    },
    {
      label: "Compliance",
      value: complianceLabel,
      tone: complianceTone,
    },
    {
      label: food ? "Cold chain" : "BIS",
      value: food
        ? deal.coldChainRequired
          ? "Required"
          : "No"
        : deal.complianceHold
          ? "Check"
          : "Clear",
      tone:
        food && deal.coldChainRequired
          ? "warn"
          : food
            ? "good"
            : deal.complianceHold
              ? "warn"
              : "good",
    },
  ];

  return (
    <div className="grid grid-cols-2 gap-2 md:grid-cols-4">
      {tiles.map((t) => (
        <div
          key={t.label}
          className={`rounded-lg border p-3 ${
            t.tone === "bad"
              ? "border-bad/40 bg-bad/5"
              : t.tone === "warn"
                ? "border-warn/40 bg-warn/5"
                : t.tone === "good"
                  ? "border-good/30 bg-good/5"
                  : "border-line bg-muted/20"
          }`}
        >
          <div className="text-[10px] uppercase tracking-wide text-white/40">
            {t.label}
          </div>
          <div
            className={`mt-1 font-mono text-xl ${
              t.tone === "bad"
                ? "text-bad"
                : t.tone === "warn"
                  ? "text-warn"
                  : t.tone === "good"
                    ? "text-good"
                    : "text-white"
            }`}
          >
            {t.value}
          </div>
          {t.hint && (
            <div className="mt-0.5 text-[10px] text-white/40">{t.hint}</div>
          )}
        </div>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Related records — contacts at the buyer + other deals with the same buyer.
// Fetches /api/organizations/:buyerOrgId which already returns contacts + deals.
// ---------------------------------------------------------------------------

interface RelatedOrg {
  id: string;
  legalName: string;
  kind: string | null;
  contacts: Array<{ id: string; fullName: string; title: string | null }>;
  deals: Array<{
    id: string;
    dealRef: string;
    status: string;
    product: string;
  }>;
}

function RelatedRecordsCard({ deal }: { deal: DealDetail }) {
  const [org, setOrg] = useState<RelatedOrg | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch(`/api/organizations/${deal.buyerOrgId}`)
      .then(async (res) => {
        if (!res.ok) throw new Error(`${res.status}`);
        return res.json();
      })
      .then((body: { organization: RelatedOrg }) => {
        if (!cancelled) setOrg(body.organization);
      })
      .catch((err: Error) => {
        if (!cancelled) setError(err.message);
      });
    return () => {
      cancelled = true;
    };
  }, [deal.buyerOrgId]);

  if (error) return null;
  if (!org) return null;

  const otherDeals = org.deals.filter((d) => d.id !== deal.id).slice(0, 4);

  return (
    <div className="grid gap-3 md:grid-cols-2">
      <Card title={`Contacts at ${org.legalName}`}>
        {org.contacts.length === 0 ? (
          <p className="text-xs text-white/50">
            No contacts on file.{" "}
            <Link
              href={`/app/chat?ask=${encodeURIComponent(`Add a contact at ${org.legalName}: `)}`}
              className="text-accent hover:underline"
            >
              Add one →
            </Link>
          </p>
        ) : (
          <ul className="flex flex-col gap-1">
            {org.contacts.slice(0, 5).map((c) => (
              <li key={c.id} className="flex items-center justify-between text-sm">
                <Link
                  href={`/app/contacts/${c.id}`}
                  className="text-white/90 hover:text-accent hover:underline"
                >
                  {c.fullName}
                </Link>
                {c.title && (
                  <span className="text-xs text-white/40">{c.title}</span>
                )}
              </li>
            ))}
            {org.contacts.length > 5 && (
              <li className="text-[11px] text-white/40">
                +{org.contacts.length - 5} more →{" "}
                <Link
                  href={`/app/companies/${org.id}`}
                  className="text-accent hover:underline"
                >
                  view all
                </Link>
              </li>
            )}
          </ul>
        )}
      </Card>
      <Card title={`Other deals with ${org.legalName}`}>
        {otherDeals.length === 0 ? (
          <p className="text-xs text-white/50">No other deals with this buyer.</p>
        ) : (
          <ul className="flex flex-col gap-1">
            {otherDeals.map((d) => (
              <li key={d.id} className="flex items-center justify-between text-sm">
                <Link
                  href={`/app/deals/${d.id}`}
                  className="font-mono text-accent hover:underline"
                >
                  {d.dealRef}
                </Link>
                <span className="text-xs text-white/50">
                  {PRODUCT_LABELS[d.product] ?? d.product} · {d.status}
                </span>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}
