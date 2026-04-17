"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { ActivityTimeline } from "@/components/activity/activity-timeline";

interface OrganizationContact {
  id: string;
  fullName: string;
  title: string | null;
  email: string | null;
  phone: string | null;
  optedOut: boolean;
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
}

export default function CompanyDetailPage({
  params,
}: {
  params: { id: string };
}) {
  const [org, setOrg] = useState<OrganizationDetail | null>(null);
  const [error, setError] = useState<string | null>(null);

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
          setOrg(body.organization);
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
        <Link
          href={`/app/chat?ask=${encodeURIComponent(`Tell me about ${org.legalName}`)}`}
          className="rounded-md border border-line px-3 py-1.5 text-sm text-white/80 hover:border-accent hover:text-white"
        >
          Ask Vex →
        </Link>
      </header>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <div className="lg:col-span-2 flex flex-col gap-4">
          <section className="rounded-lg border border-line bg-muted/20 p-4">
            <h3 className="mb-3 text-sm font-semibold uppercase tracking-wide text-white/50">
              Details
            </h3>
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

          <section className="rounded-lg border border-line bg-muted/20 p-4">
            <div className="mb-3 flex items-center justify-between">
              <h3 className="text-sm font-semibold uppercase tracking-wide text-white/50">
                Contacts ({org.contactCount})
              </h3>
              <Link
                href="/app/contacts"
                className="text-xs text-accent hover:underline"
              >
                View all →
              </Link>
            </div>
            {org.contacts.length === 0 ? (
              <p className="text-sm text-white/50">No contacts at this company yet.</p>
            ) : (
              <ul className="flex flex-col divide-y divide-line/60">
                {org.contacts.map((c) => (
                  <li
                    key={c.id}
                    className="flex items-start justify-between py-2 text-sm"
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
            )}
          </section>
        </div>

        <aside className="flex flex-col gap-3">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-white/50">
            Activity
          </h2>
          <ActivityTimeline subjectType="organization" subjectId={org.id} />
        </aside>
      </div>
    </div>
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
