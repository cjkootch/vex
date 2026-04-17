"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { ActivityTimeline } from "@/components/activity/activity-timeline";
import { DealStatusMenu } from "@/components/crm/deal-status-menu";

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
          <Link
            href={`/app/chat?ask=${encodeURIComponent(`Score deal ${deal.dealRef}`)}`}
            className="rounded-md border border-line px-3 py-1.5 text-sm text-white/80 hover:border-accent hover:text-white"
          >
            Ask Vex →
          </Link>
        </div>
      </header>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <div className="lg:col-span-2 flex flex-col gap-4">
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
            <Field
              label="Buyer"
              value={deal.buyerName ?? deal.buyerOrgId}
            />
            <Field
              label="Seller"
              value={deal.sellerName ?? deal.sellerOrgId ?? "—"}
            />
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

        <aside className="flex flex-col gap-3">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-white/50">
            Activity
          </h2>
          <ActivityTimeline subjectType="fuel_deal" subjectId={deal.id} />
        </aside>
      </div>
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
