"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { ActivityTimeline } from "@/components/activity/activity-timeline";
import { DocumentsPanel } from "@/components/documents/documents-panel";
import { EditCompanyForm } from "@/components/crm/edit-company-form";
import { Tabs } from "@/components/ui/tabs";

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

      <header className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl text-white">{org.legalName}</h1>
          <p className="mt-1 text-sm text-white/60">
            {org.domain ?? "—"} · {org.industry ?? "no industry"}
            {org.fitScore !== null && ` · fit ${Math.round(org.fitScore * 100)}`}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => setEditOpen(true)}
            className="rounded-md border border-line px-3 py-1.5 text-sm text-white/80 hover:border-accent hover:text-white"
          >
            Edit
          </button>
          <Link
            href={`/app/chat?ask=${encodeURIComponent(`Tell me about ${org.legalName}`)}`}
            className="rounded-md border border-line px-3 py-1.5 text-sm text-white/80 hover:border-accent hover:text-white"
          >
            Ask Vex →
          </Link>
        </div>
      </header>

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
            content: <OverviewTab org={org} />,
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

function OverviewTab({ org }: { org: OrganizationDetail }) {
  return (
    <section className="rounded-lg border border-line bg-muted/20 p-4">
      <div className="grid grid-cols-[140px_1fr] gap-2 text-sm">
        <span className="text-white/50">Status</span>
        <span className="text-white/90">{org.status}</span>
        <span className="text-white/50">Domain</span>
        <span className="text-white/90">{org.domain ?? "—"}</span>
        <span className="text-white/50">Industry</span>
        <span className="text-white/90">{org.industry ?? "—"}</span>
        <span className="text-white/50">Source</span>
        <span className="text-white/90">{org.sourceOfTruth ?? "—"}</span>
        <span className="text-white/50">External keys</span>
        <span className="text-white/90 font-mono text-xs">
          {Object.keys(org.externalKeys).length === 0
            ? "—"
            : Object.entries(org.externalKeys)
                .map(([k, v]) => `${k}: ${v}`)
                .join(", ")}
        </span>
      </div>
    </section>
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
