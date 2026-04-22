"use client";

import Link from "next/link";
import { formatDistanceToNow } from "date-fns";
import { usePulsingFetch } from "@/lib/use-pulsing-fetch";

/**
 * LinkedIn-style hero band for a contact detail page. Mirrors the
 * CompanyHero layout — banner strip, monogram avatar, headline,
 * eyebrow + stats row — so the two detail surfaces read as one
 * family.
 *
 * Key quick stats: primary company · title · email · phone ·
 * open deals they're on · last touchpoint · #companies. All fetched
 * from /api/contacts/:id/pulse so the hero loads in one request.
 */

interface ContactPulse {
  contact: {
    id: string;
    fullName: string;
    title: string | null;
    emails: string[];
    phones: string[];
    status: string;
    optOutAt: string | null;
  };
  primaryOrg: { id: string; legalName: string } | null;
  allOrgs: Array<{
    orgId: string;
    orgName: string;
    role: string | null;
    isPrimary: boolean;
  }>;
  openDealsCount: number;
  lastTouchpointAt: string | null;
  lastTouchpointChannel: string | null;
  activityLast7d: number;
}

export function ContactHero({
  contactId,
  fallback,
  actions,
}: {
  contactId: string;
  fallback: {
    fullName: string;
    title: string | null;
    emails: string[];
    phones: string[];
    status: string;
    optOutReason: string | null;
  };
  actions?: React.ReactNode;
}): React.ReactElement {
  const pulse = usePulsingFetch<ContactPulse>(
    `/api/contacts/${contactId}/pulse`,
    { deps: [contactId] },
  );

  const fullName = pulse?.contact.fullName ?? fallback.fullName;
  const title = pulse?.contact.title ?? fallback.title;
  const emails = pulse?.contact.emails ?? fallback.emails;
  const phones = pulse?.contact.phones ?? fallback.phones;
  const email = emails[0] ?? null;
  const phone = phones[0] ?? null;
  const primaryOrg = pulse?.primaryOrg ?? null;
  const suppressed =
    pulse?.contact.optOutAt ??
    (fallback.status === "suppressed" ? "suppressed" : null);

  const monogram = fullName
    .split(" ")
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]?.toUpperCase() ?? "")
    .join("");

  return (
    <section className="overflow-hidden rounded-xl border border-line-soft bg-surface-1 shadow-soft">
      <div
        aria-hidden="true"
        className="h-16 bg-[linear-gradient(120deg,rgba(124,92,255,0.14)_0%,rgba(124,92,255,0.04)_40%,rgba(22,24,31,0.9)_100%)]"
      />
      <div className="flex flex-col gap-5 px-6 pb-5 pt-0">
        <div className="flex flex-wrap items-start justify-between gap-4 -mt-8">
          <div className="flex items-end gap-4">
            <div
              aria-hidden="true"
              className="flex h-16 w-16 flex-shrink-0 items-center justify-center rounded-full border border-line-soft bg-surface-2 text-xl font-semibold text-accent-strong shadow-soft"
            >
              {monogram || "·"}
            </div>
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <span className="text-eyebrow text-text-muted">Contact</span>
                {suppressed ? (
                  <span className="rounded-md border border-bad/40 bg-bad/10 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider2 text-bad">
                    Suppressed
                  </span>
                ) : null}
              </div>
              <h1 className="mt-1 text-title text-text-primary">{fullName}</h1>
              <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-text-secondary">
                {title && <span>{title}</span>}
                {primaryOrg ? (
                  <>
                    {title && <span className="text-text-muted/50">·</span>}
                    <Link
                      href={`/app/companies/${primaryOrg.id}`}
                      className="font-medium text-text-primary/90 hover:text-accent-strong hover:underline"
                    >
                      {primaryOrg.legalName}
                    </Link>
                  </>
                ) : null}
                {pulse && pulse.allOrgs.length > 1 ? (
                  <span className="num rounded-full border border-line-soft bg-surface-2/60 px-2 py-0.5 text-[10px] text-text-muted">
                    +{pulse.allOrgs.length - 1} other{" "}
                    {pulse.allOrgs.length - 1 === 1 ? "company" : "companies"}
                  </span>
                ) : null}
              </div>
            </div>
          </div>
          {actions ? (
            <div className="flex flex-shrink-0 items-center gap-2 pt-8">
              {actions}
            </div>
          ) : null}
        </div>

        <dl className="grid grid-cols-2 gap-x-5 gap-y-3 border-t border-line-soft pt-4 sm:grid-cols-3 lg:grid-cols-5">
          <StatCell
            label="Email"
            value={email ?? "—"}
            mono={Boolean(email)}
            href={email ? `mailto:${email}` : undefined}
            truncate
          />
          <StatCell
            label="Phone"
            value={phone ?? "—"}
            mono={Boolean(phone)}
            href={phone ? `tel:${phone}` : undefined}
          />
          <StatCell
            label="Open deals"
            value={pulse ? String(pulse.openDealsCount) : "—"}
            numeric
          />
          <StatCell
            label="Last touch"
            value={
              pulse?.lastTouchpointAt
                ? formatDistanceToNow(new Date(pulse.lastTouchpointAt), {
                    addSuffix: true,
                  })
                : pulse
                  ? "never"
                  : "—"
            }
            sub={pulse?.lastTouchpointChannel ?? undefined}
          />
          <StatCell
            label="Activity (7d)"
            value={pulse ? String(pulse.activityLast7d) : "—"}
            sub="touchpoints"
            numeric
          />
        </dl>

        {pulse && pulse.allOrgs.length > 1 ? (
          <div className="flex flex-col gap-2">
            <span className="text-eyebrow text-text-secondary">
              Also represents
            </span>
            <ul className="flex flex-wrap gap-2">
              {pulse.allOrgs
                .filter((o) => !o.isPrimary)
                .map((o) => (
                  <li key={o.orgId}>
                    <Link
                      href={`/app/companies/${o.orgId}`}
                      className="inline-flex items-center gap-1.5 rounded-full border border-line-soft bg-surface-2/60 px-2.5 py-0.5 text-xs text-text-secondary transition-colors hover:border-line-strong hover:text-text-primary"
                    >
                      {o.orgName}
                      {o.role ? (
                        <span className="text-text-muted">· {o.role}</span>
                      ) : null}
                    </Link>
                  </li>
                ))}
            </ul>
          </div>
        ) : null}
      </div>
    </section>
  );
}

function StatCell({
  label,
  value,
  sub,
  numeric,
  mono,
  truncate,
  href,
}: {
  label: string;
  value: string;
  sub?: string | undefined;
  numeric?: boolean | undefined;
  mono?: boolean | undefined;
  truncate?: boolean | undefined;
  href?: string | undefined;
}) {
  const cls = `${numeric ? "num " : ""}${mono ? "num-mono " : ""}text-sm font-semibold text-text-primary${truncate ? " truncate" : ""}`;
  const valueNode = href ? (
    <a className={`${cls} hover:text-accent-strong`} href={href}>
      {value}
    </a>
  ) : (
    <span className={cls}>{value}</span>
  );
  return (
    <div className="flex min-w-0 flex-col gap-0.5">
      <dt className="text-eyebrow text-text-muted">{label}</dt>
      <dd className="min-w-0">{valueNode}</dd>
      {sub ? (
        <div className="text-[11px] text-text-muted">{sub}</div>
      ) : null}
    </div>
  );
}
