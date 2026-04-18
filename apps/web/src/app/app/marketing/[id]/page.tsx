"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { Tabs } from "@/components/ui/tabs";

interface CampaignTouchpoint {
  id: string;
  channel: string;
  actor: string | null;
  occurredAt: string;
  contactId: string | null;
  orgId: string | null;
  leadId: string | null;
  campaignId: string | null;
  metadata: Record<string, unknown>;
}

interface CampaignDetail {
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
  touchpoints: CampaignTouchpoint[];
}

export default function CampaignDetailPage({
  params,
}: {
  params: { id: string };
}) {
  const [campaign, setCampaign] = useState<CampaignDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState("overview");

  useEffect(() => {
    let cancelled = false;
    setCampaign(null);
    fetch(`/api/marketing/campaigns/${params.id}`)
      .then(async (res) => {
        if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
        return res.json();
      })
      .then((body: { campaign: CampaignDetail }) => {
        if (!cancelled) {
          setCampaign(body.campaign);
          setError(null);
        }
      })
      .catch((err: Error) => {
        if (!cancelled) setError(err.message);
      });
    return () => {
      cancelled = true;
    };
  }, [params.id]);

  if (error) {
    return (
      <div className="mx-auto max-w-3xl px-6 py-8">
        <Breadcrumb ref={null} />
        <div className="mt-4 rounded-md border border-bad/40 bg-bad/10 px-3 py-2 text-sm text-bad">
          Couldn&apos;t load campaign: {error}
        </div>
      </div>
    );
  }

  if (!campaign) {
    return (
      <div className="mx-auto max-w-3xl px-6 py-8">
        <Breadcrumb ref={null} />
        <div className="mt-4 text-sm text-white/40">Loading campaign…</div>
      </div>
    );
  }

  const ref = campaignRef(campaign);

  return (
    <div className="mx-auto flex max-w-5xl flex-col gap-6 px-6 py-6">
      <Breadcrumb ref={ref} />

      <header className="flex items-start justify-between gap-4">
        <div>
          <div className="flex items-center gap-3">
            <h1 className="font-mono text-2xl text-white">{ref}</h1>
            <StatusPill status={campaign.status} />
          </div>
          <p className="mt-1 text-sm text-white/60">
            {campaign.objective ?? "No stated objective."}
          </p>
        </div>
        <Link
          href={`/app/chat?ask=${encodeURIComponent(`Why did ${ref} drop in opens?`)}`}
          className="rounded-md border border-line px-3 py-1.5 text-sm text-white/80 hover:border-accent hover:text-white"
        >
          Ask Vex →
        </Link>
      </header>

      {/* KPI rail — rollup metrics. */}
      <KpiRail campaign={campaign} />

      <Tabs
        active={activeTab}
        onChange={setActiveTab}
        tabs={[
          {
            id: "overview",
            label: "Overview",
            content: <OverviewTab campaign={campaign} />,
          },
          {
            id: "touchpoints",
            label: "Touchpoints",
            count: campaign.touchpoints.length,
            content: <TouchpointsTab touchpoints={campaign.touchpoints} />,
          },
        ]}
      />
    </div>
  );
}

function KpiRail({ campaign }: { campaign: CampaignDetail }) {
  const items: { label: string; value: string }[] = [
    { label: "Sent", value: formatCount(campaign.sent) },
    { label: "Delivered", value: formatCount(campaign.delivered) },
    { label: "Opened", value: formatCount(campaign.opened) },
    { label: "Clicked", value: formatCount(campaign.clicked) },
    { label: "Bounced", value: formatCount(campaign.bounced) },
    { label: "Touchpoints", value: formatCount(campaign.touchpointCount) },
  ];
  return (
    <div className="-mx-6 overflow-x-auto px-6 md:mx-0 md:px-0">
      <div className="grid min-w-[640px] grid-cols-6 gap-2 md:min-w-0">
        {items.map((item) => (
          <div
            key={item.label}
            className="rounded-lg border border-line bg-muted/20 px-3 py-3"
          >
            <div className="text-[10px] uppercase tracking-wide text-white/50">
              {item.label}
            </div>
            <div className="mt-1 font-mono text-lg text-white">
              {item.value}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function OverviewTab({ campaign }: { campaign: CampaignDetail }) {
  return (
    <div className="flex flex-col gap-4">
      <Card title="Rollups">
        <Field label="Sent" value={formatCount(campaign.sent)} />
        <Field label="Delivered" value={formatCount(campaign.delivered)} />
        <Field label="Opened" value={formatCount(campaign.opened)} />
        <Field label="Clicked" value={formatCount(campaign.clicked)} />
        <Field label="Bounced" value={formatCount(campaign.bounced)} />
        <Field
          label="Open rate"
          value={rate(campaign.opened, campaign.delivered || campaign.sent)}
        />
        <Field
          label="Click rate"
          value={rate(campaign.clicked, campaign.delivered || campaign.sent)}
        />
      </Card>

      <Card title="Config">
        <Field label="Channel" value={campaign.channel} />
        <Field label="Source" value={campaign.source ?? "—"} />
        <Field label="Medium" value={campaign.medium ?? "—"} />
        <Field label="Account" value={campaign.accountRef ?? "—"} />
        <Field label="Spend" value={formatSpend(campaign.spend)} />
        <Field label="Objective" value={campaign.objective ?? "—"} />
        <Field label="Created" value={shortDateTime(campaign.createdAt)} />
        <Field label="Updated" value={shortDateTime(campaign.updatedAt)} />
      </Card>
    </div>
  );
}

function TouchpointsTab({
  touchpoints,
}: {
  touchpoints: CampaignTouchpoint[];
}) {
  if (touchpoints.length === 0) {
    return (
      <div className="rounded-md border border-line bg-muted/20 px-3 py-6 text-center text-sm text-white/40">
        No touchpoints recorded yet.
      </div>
    );
  }
  return (
    <ul className="flex flex-col gap-2">
      {touchpoints.map((t) => (
        <li
          key={t.id}
          className="rounded-lg border border-line bg-muted/20 p-3"
        >
          <div className="flex items-start justify-between gap-3 text-sm">
            <div className="min-w-0">
              <span className="font-mono text-accent">{t.channel}</span>
              {t.actor && (
                <>
                  <span className="mx-2 text-white/30">·</span>
                  <span className="text-white/70">{t.actor}</span>
                </>
              )}
            </div>
            <span className="flex-shrink-0 text-xs text-white/50">
              {shortDateTime(t.occurredAt)}
            </span>
          </div>
          {(t.contactId || t.orgId) && (
            <div className="mt-1.5 flex flex-wrap gap-3 text-xs">
              {t.contactId && (
                <Link
                  href={`/app/contacts/${t.contactId}`}
                  className="text-accent hover:underline"
                >
                  contact: {t.contactId.slice(-6)}
                </Link>
              )}
              {t.orgId && (
                <Link
                  href={`/app/companies/${t.orgId}`}
                  className="text-accent hover:underline"
                >
                  org: {t.orgId.slice(-6)}
                </Link>
              )}
            </div>
          )}
        </li>
      ))}
    </ul>
  );
}

function Breadcrumb({ ref }: { ref: string | null }) {
  return (
    <nav className="text-xs text-white/50">
      <Link href="/app" className="hover:text-white/80">
        Home
      </Link>
      <span className="mx-1">/</span>
      <Link href="/app/marketing" className="hover:text-white/80">
        Marketing
      </Link>
      {ref && (
        <>
          <span className="mx-1">/</span>
          <span className="font-mono text-white/70">{ref}</span>
        </>
      )}
    </nav>
  );
}

function Card({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section className="rounded-lg border border-line bg-muted/20 p-4">
      <h3 className="mb-3 text-sm font-semibold uppercase tracking-wide text-white/50">
        {title}
      </h3>
      <div className="flex flex-col gap-2">{children}</div>
    </section>
  );
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div className="grid grid-cols-[120px_1fr] gap-3 text-sm">
      <span className="text-white/50">{label}</span>
      <span className="text-white/90">{value}</span>
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
      className={`inline-block rounded px-2 py-0.5 text-xs ${
        palette[status] ?? "bg-muted/60 text-white/70"
      }`}
    >
      {status}
    </span>
  );
}

function campaignRef(c: CampaignDetail): string {
  const left = c.source ?? c.channel;
  const right = c.medium;
  if (right) return `${left} · ${right}`;
  return left;
}

function formatCount(n: number | null | undefined): string {
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

function rate(numerator: number, denominator: number): string {
  if (!denominator) return "—";
  const r = numerator / denominator;
  return `${(r * 100).toFixed(1)}%`;
}

function shortDateTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}
