"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { ActivityTimeline } from "@/components/activity/activity-timeline";

interface Membership {
  tenantId: string;
  contactId: string;
  orgId: string;
  role: string | null;
  isPrimary: boolean;
  since: string;
  until: string | null;
  createdAt: string;
  updatedAt: string;
}

interface Contact {
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
  createdAt: string;
  updatedAt: string;
}

interface ContactResponse {
  contact: Contact;
  memberships: Membership[];
}

export default function ContactDetailPage({
  params,
}: {
  params: { id: string };
}) {
  const [data, setData] = useState<ContactResponse | null>(null);
  const [orgNames, setOrgNames] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setData(null);
    fetch(`/api/contacts/${params.id}`)
      .then(async (res) => {
        if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
        return res.json();
      })
      .then((body: ContactResponse) => {
        if (!cancelled) {
          setData(body);
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

  // Look up the org names so the membership list shows labels.
  useEffect(() => {
    let cancelled = false;
    fetch("/api/organizations")
      .then(async (res) => {
        if (!res.ok) throw new Error(`${res.status}`);
        return res.json();
      })
      .then(
        (body: {
          organizations: Array<{ id: string; legalName: string }>;
        }) => {
          if (cancelled) return;
          const map: Record<string, string> = {};
          for (const o of body.organizations) map[o.id] = o.legalName;
          setOrgNames(map);
        },
      )
      .catch(() => {
        /* chips fall back to id */
      });
    return () => {
      cancelled = true;
    };
  }, []);

  async function setPrimary(orgId: string): Promise<void> {
    if (!data) return;
    try {
      const res = await fetch(
        `/api/contacts/${params.id}/memberships/${orgId}/primary`,
        { method: "POST" },
      );
      if (!res.ok) throw new Error(`${res.status}`);
      setRefreshKey((k) => k + 1);
    } catch (err) {
      setError((err as Error).message);
    }
  }

  async function removeMembership(orgId: string): Promise<void> {
    if (!data) return;
    if (!window.confirm("Remove this company membership?")) return;
    try {
      const res = await fetch(
        `/api/contacts/${params.id}/memberships/${orgId}`,
        { method: "DELETE" },
      );
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as {
          message?: string;
        };
        throw new Error(body.message ?? `${res.status}`);
      }
      setRefreshKey((k) => k + 1);
    } catch (err) {
      setError((err as Error).message);
    }
  }

  if (error) {
    return (
      <div className="mx-auto max-w-3xl px-6 py-8">
        <Breadcrumb name={null} />
        <div className="mt-4 rounded-md border border-bad/40 bg-bad/10 px-3 py-2 text-sm text-bad">
          Couldn&apos;t load contact: {error}
        </div>
      </div>
    );
  }

  if (!data) {
    return (
      <div className="mx-auto max-w-3xl px-6 py-8">
        <Breadcrumb name={null} />
        <div className="mt-4 text-sm text-white/40">Loading contact…</div>
      </div>
    );
  }

  const { contact, memberships } = data;

  return (
    <div className="mx-auto flex max-w-5xl flex-col gap-6 px-6 py-6">
      <Breadcrumb name={contact.fullName} />

      <header className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl text-white">{contact.fullName}</h1>
          <p className="mt-1 text-sm text-white/60">
            {contact.title ?? "—"} · {contact.emails[0] ?? "no email"}
          </p>
          {contact.optOutAt && (
            <div className="mt-2 inline-flex rounded bg-bad/20 px-2 py-0.5 text-xs text-bad">
              suppressed — {contact.optOutReason ?? "no reason"}
            </div>
          )}
        </div>
        <Link
          href={`/app/chat?ask=${encodeURIComponent(`What do I know about ${contact.fullName}?`)}`}
          className="rounded-md border border-line px-3 py-1.5 text-sm text-white/80 hover:border-accent hover:text-white"
        >
          Ask Vex →
        </Link>
      </header>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <div className="lg:col-span-2 flex flex-col gap-4">
          <section className="rounded-lg border border-line bg-muted/20 p-4">
            <h3 className="mb-3 text-sm font-semibold uppercase tracking-wide text-white/50">
              Contact info
            </h3>
            <div className="grid grid-cols-[120px_1fr] gap-2 text-sm">
              <span className="text-white/50">Emails</span>
              <span className="text-white/90">
                {contact.emails.length > 0 ? contact.emails.join(", ") : "—"}
              </span>
              <span className="text-white/50">Phones</span>
              <span className="text-white/90">
                {contact.phones.length > 0 ? contact.phones.join(", ") : "—"}
              </span>
              <span className="text-white/50">Status</span>
              <span className="text-white/90">{contact.status}</span>
            </div>
          </section>

          <section className="rounded-lg border border-line bg-muted/20 p-4">
            <h3 className="mb-3 text-sm font-semibold uppercase tracking-wide text-white/50">
              Companies ({memberships.length})
            </h3>
            <ul className="flex flex-col divide-y divide-line/60">
              {memberships.map((m) => (
                <li
                  key={m.orgId}
                  className="flex items-center justify-between py-2 text-sm"
                >
                  <div>
                    <Link
                      href={`/app/companies/${m.orgId}`}
                      className="font-medium text-accent hover:underline"
                    >
                      {orgNames[m.orgId] ?? m.orgId.slice(-6)}
                    </Link>
                    {m.isPrimary && (
                      <span className="ml-2 rounded bg-accent/25 px-1.5 py-0.5 text-[10px] uppercase tracking-wider text-accent">
                        Primary
                      </span>
                    )}
                    <div className="text-xs text-white/50">
                      {m.role ?? "no role"}
                    </div>
                  </div>
                  <div className="flex gap-2">
                    {!m.isPrimary && (
                      <>
                        <button
                          type="button"
                          onClick={() => void setPrimary(m.orgId)}
                          className="text-xs text-white/70 hover:text-accent"
                        >
                          Make primary
                        </button>
                        <button
                          type="button"
                          onClick={() => void removeMembership(m.orgId)}
                          className="text-xs text-white/50 hover:text-bad"
                        >
                          Remove
                        </button>
                      </>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          </section>
        </div>

        <aside className="flex flex-col gap-3">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-white/50">
            Activity
          </h2>
          <ActivityTimeline subjectType="contact" subjectId={contact.id} />
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
      <Link href="/app/contacts" className="hover:text-white/80">
        Contacts
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
