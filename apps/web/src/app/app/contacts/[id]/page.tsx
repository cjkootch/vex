"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { ActivityTimeline } from "@/components/activity/activity-timeline";
import { DocumentsPanel } from "@/components/documents/documents-panel";
import { EditContactForm } from "@/components/crm/edit-contact-form";
import { MergeContactDialog } from "@/components/crm/merge-contact-dialog";
import { QuickActions } from "@/components/crm/quick-actions";
import { SignalsPanel } from "@/components/signals/signals-panel";
import { Tabs } from "@/components/ui/tabs";

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

interface ContactDeal {
  id: string;
  dealRef: string;
  status: string;
  product: string;
  volumeUsg: number;
  buyerOrgId: string;
}

interface ContactResponse {
  contact: Contact;
  memberships: Membership[];
  deals: ContactDeal[];
}

export default function ContactDetailPage({
  params,
}: {
  params: { id: string };
}) {
  const router = useRouter();
  const [data, setData] = useState<ContactResponse | null>(null);
  const [orgNames, setOrgNames] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const [activeTab, setActiveTab] = useState("overview");
  const [editOpen, setEditOpen] = useState(false);
  const [mergeOpen, setMergeOpen] = useState(false);

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
          setData({
            ...body,
            memberships: body.memberships ?? [],
            deals: body.deals ?? [],
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

  const { contact, memberships, deals } = data;

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
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => setEditOpen(true)}
            className="rounded-md border border-line px-3 py-1.5 text-sm text-white/80 hover:border-accent hover:text-white"
          >
            Edit
          </button>
          <button
            type="button"
            onClick={() => setMergeOpen(true)}
            className="rounded-md border border-line px-3 py-1.5 text-sm text-white/80 hover:border-bad hover:text-bad"
          >
            Merge…
          </button>
          <Link
            href={`/app/chat?ask=${encodeURIComponent(`What do I know about ${contact.fullName}?`)}`}
            className="rounded-md border border-line px-3 py-1.5 text-sm text-white/80 hover:border-accent hover:text-white"
          >
            Ask Vex →
          </Link>
        </div>
      </header>

      <MergeContactDialog
        open={mergeOpen}
        source={{ id: contact.id, fullName: contact.fullName }}
        onClose={() => setMergeOpen(false)}
        onMerged={(targetId) => {
          setMergeOpen(false);
          router.push(`/app/contacts/${targetId}`);
        }}
      />

      <QuickActions
        items={[
          { label: "Email", ask: `Draft an email to ${contact.fullName}` },
          { label: "SMS", ask: `Text ${contact.fullName}: ` },
          { label: "Call", ask: `Have Vex call ${contact.fullName}: ` },
          {
            label: "Schedule follow-up",
            ask: `Remind me to follow up with ${contact.fullName}: `,
          },
          {
            label: "Add note",
            ask: `Add a note on ${contact.fullName}: `,
          },
        ]}
      />

      <SignalsPanel subjectType="contact" subjectId={contact.id} />

      <EditContactForm
        open={editOpen}
        contact={contact}
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
            content: <OverviewTab contact={contact} />,
          },
          {
            id: "companies",
            label: "Companies",
            count: memberships.length,
            content: (
              <CompaniesTab
                memberships={memberships}
                orgNames={orgNames}
                onMakePrimary={setPrimary}
                onRemove={removeMembership}
              />
            ),
          },
          {
            id: "deals",
            label: "Deals",
            count: deals.length,
            content: <DealsTab deals={deals} orgNames={orgNames} />,
          },
          {
            id: "documents",
            label: "Documents",
            content: (
              <DocumentsPanel subjectType="contact" subjectId={contact.id} />
            ),
          },
          {
            id: "activity",
            label: "Activity",
            content: (
              <ActivityTimeline subjectType="contact" subjectId={contact.id} />
            ),
          },
        ]}
      />
    </div>
  );
}

function OverviewTab({ contact }: { contact: Contact }) {
  return (
    <section className="rounded-lg border border-line bg-muted/20 p-4">
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
  );
}

function CompaniesTab({
  memberships,
  orgNames,
  onMakePrimary,
  onRemove,
}: {
  memberships: Membership[];
  orgNames: Record<string, string>;
  onMakePrimary: (orgId: string) => Promise<void>;
  onRemove: (orgId: string) => Promise<void>;
}) {
  return (
    <ul className="flex flex-col divide-y divide-line/60 rounded-lg border border-line bg-muted/20 px-4">
      {memberships.map((m) => (
        <li
          key={m.orgId}
          className="flex items-center justify-between py-3 text-sm"
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
                  onClick={() => void onMakePrimary(m.orgId)}
                  className="text-xs text-white/70 hover:text-accent"
                >
                  Make primary
                </button>
                <button
                  type="button"
                  onClick={() => void onRemove(m.orgId)}
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
  );
}

function DealsTab({
  deals,
  orgNames,
}: {
  deals: ContactDeal[];
  orgNames: Record<string, string>;
}) {
  if (deals.length === 0) {
    return (
      <p className="rounded-md border border-line bg-muted/20 px-3 py-4 text-sm text-white/50">
        No deals reference this contact as buyer yet.
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
              {d.product} · {formatVolume(d.volumeUsg)} ·{" "}
              <Link
                href={`/app/companies/${d.buyerOrgId}`}
                className="hover:text-accent hover:underline"
              >
                {orgNames[d.buyerOrgId] ?? d.buyerOrgId.slice(-6)}
              </Link>
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
