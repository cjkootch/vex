"use client";

import Link from "next/link";
import { formatDistanceToNow } from "date-fns";
import { usePulsingFetch } from "@/lib/use-pulsing-fetch";

/**
 * LinkedIn-style hero band for a counterparty (company) detail page.
 * Structure:
 *
 *   ┌─────────────────────────────────────────────────────────┐
 *   │ [monogram]  Eyebrow                       [actions ----]│
 *   │             Big legal name                               │
 *   │             domain · industry · role chips              │
 *   │─────────────────────────────────────────────────────────│
 *   │  Stat · Stat · Stat · Stat · Stat · Stat               │
 *   └─────────────────────────────────────────────────────────┘
 *
 * All aggregation comes from /api/organizations/:id/pulse. The
 * component owns its own fetch so the company detail page doesn't
 * have to thread state through.
 *
 * The hero is purely presentational — the existing CTA row (Edit,
 * Ask Vex) lives above this in the page layout so both still
 * render. Future work can fold the CTAs into the hero itself;
 * keeping them separate for now reduces rewrite risk.
 */

interface OrgPulse {
  org: {
    id: string;
    legalName: string;
    domain: string | null;
    industry: string | null;
    status: string;
    ofacStatus: string;
    ofacScreenedAt: string | null;
  };
  roleCounts: {
    buyer: number;
    supplier: number;
    broker: number;
    intermediary: number;
  };
  openDeals: Array<{
    dealId: string;
    dealRef: string;
    status: string;
    product: string;
    volumeUsg: number;
    volumeUnit: string;
    updatedAt: string;
    role: string;
  }>;
  closedDealCount: number;
  lifetimeVolumeUsg: number;
  contactCount: number;
  riskTier: string | null;
  riskTierScoredAt: string | null;
  lastTouchpointAt: string | null;
  lastTouchpointChannel: string | null;
}

export function CompanyHero({
  orgId,
  fallback,
  actions,
}: {
  orgId: string;
  fallback: {
    legalName: string;
    domain: string | null;
    industry: string | null;
    fitScore: number | null;
  };
  actions?: React.ReactNode;
}): React.ReactElement {
  const pulse = usePulsingFetch<OrgPulse>(
    `/api/organizations/${orgId}/pulse`,
    { deps: [orgId] },
  );

  const legalName = pulse?.org.legalName ?? fallback.legalName;
  const domain = pulse?.org.domain ?? fallback.domain;
  const industry = pulse?.org.industry ?? fallback.industry;
  const monogram = legalName
    .split(" ")
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]?.toUpperCase() ?? "")
    .join("");

  return (
    <section className="overflow-hidden rounded-xl border border-line-soft bg-surface-1 shadow-soft">
      {/* banner */}
      <div
        aria-hidden="true"
        className="h-16 bg-[linear-gradient(120deg,rgba(124,92,255,0.14)_0%,rgba(124,92,255,0.04)_40%,rgba(22,24,31,0.9)_100%)]"
      />
      <div className="flex flex-col gap-5 px-6 pb-5 pt-0">
        <div className="flex flex-wrap items-start justify-between gap-4 -mt-8">
          <div className="flex items-end gap-4">
            <div
              aria-hidden="true"
              className="flex h-16 w-16 flex-shrink-0 items-center justify-center rounded-lg border border-line-soft bg-surface-2 text-xl font-semibold text-accent-strong shadow-soft"
            >
              {monogram || "·"}
            </div>
            <div className="min-w-0">
              <div className="text-eyebrow text-text-muted">Counterparty</div>
              <h1 className="mt-1 text-title text-text-primary">{legalName}</h1>
              <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-text-secondary">
                {domain && (
                  <span className="num-mono text-text-muted">{domain}</span>
                )}
                {industry && (
                  <>
                    {domain && (
                      <span className="text-text-muted/50">·</span>
                    )}
                    <span>{industry}</span>
                  </>
                )}
                {pulse ? (
                  <RoleChips counts={pulse.roleCounts} />
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

        {/* stats */}
        <dl className="grid grid-cols-2 gap-x-5 gap-y-3 border-t border-line-soft pt-4 sm:grid-cols-3 lg:grid-cols-6">
          <StatCell
            label="Open deals"
            value={
              pulse
                ? totalRoleCount(pulse.roleCounts).toString()
                : "—"
            }
            sub={pulse && totalRoleCount(pulse.roleCounts) > 0 ? "active" : undefined}
            numeric
          />
          <StatCell
            label="Lifetime volume"
            value={
              pulse ? formatVolumeShort(pulse.lifetimeVolumeUsg) : "—"
            }
            sub={
              pulse?.closedDealCount
                ? `${pulse.closedDealCount} settled`
                : undefined
            }
            numeric
          />
          <StatCell
            label="OFAC"
            value={
              pulse ? ofacShort(pulse.org.ofacStatus) : "—"
            }
            sub={
              pulse?.org.ofacScreenedAt
                ? `${formatDistanceToNow(new Date(pulse.org.ofacScreenedAt))} ago`
                : pulse
                  ? "not screened"
                  : undefined
            }
            tone={ofacTone(pulse?.org.ofacStatus)}
          />
          <StatCell
            label="Risk tier"
            value={pulse?.riskTier ? riskTierLabel(pulse.riskTier) : "—"}
            sub={
              pulse?.riskTierScoredAt
                ? `${formatDistanceToNow(new Date(pulse.riskTierScoredAt))} ago`
                : undefined
            }
            tone={riskTone(pulse?.riskTier)}
          />
          <StatCell
            label="Contacts"
            value={pulse ? String(pulse.contactCount) : "—"}
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
        </dl>

        {pulse && pulse.openDeals.length > 0 ? (
          <OpenDealsStrip deals={pulse.openDeals} />
        ) : null}
      </div>
    </section>
  );
}

function RoleChips({
  counts,
}: {
  counts: OrgPulse["roleCounts"];
}) {
  const chips: Array<{
    key: keyof OrgPulse["roleCounts"];
    label: string;
    tone: string;
  }> = [
    { key: "buyer", label: "Buyer", tone: "bg-teal-400/15 text-teal-300 border-teal-400/30" },
    { key: "supplier", label: "Supplier", tone: "bg-blue-400/15 text-blue-300 border-blue-400/30" },
    { key: "broker", label: "Broker", tone: "bg-purple-400/15 text-purple-300 border-purple-400/30" },
    { key: "intermediary", label: "Intermediary", tone: "bg-amber-400/15 text-amber-300 border-amber-400/30" },
  ];
  return (
    <>
      {chips
        .filter((c) => counts[c.key] > 0)
        .map((c) => (
          <span
            key={c.key}
            className={`num rounded-full border px-2 py-0.5 text-[10px] font-medium ${c.tone}`}
          >
            {c.label} · {counts[c.key]}
          </span>
        ))}
    </>
  );
}

function StatCell({
  label,
  value,
  sub,
  numeric,
  tone,
}: {
  label: string;
  value: string;
  sub?: string | undefined;
  numeric?: boolean | undefined;
  tone?: "good" | "warn" | "bad" | undefined;
}) {
  const toneClass =
    tone === "good"
      ? "text-emerald-300"
      : tone === "warn"
        ? "text-warn"
        : tone === "bad"
          ? "text-bad"
          : "text-text-primary";
  return (
    <div className="flex flex-col gap-0.5">
      <dt className="text-eyebrow text-text-muted">{label}</dt>
      <dd
        className={`${numeric ? "num" : ""} text-base font-semibold ${toneClass}`}
      >
        {value}
      </dd>
      {sub ? (
        <div className="text-[11px] text-text-muted">{sub}</div>
      ) : null}
    </div>
  );
}

function OpenDealsStrip({
  deals,
}: {
  deals: OrgPulse["openDeals"];
}) {
  const visible = deals.slice(0, 4);
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-baseline gap-2">
        <span className="text-eyebrow text-text-secondary">Open deals</span>
        <span className="num text-[11px] text-text-muted">
          · {deals.length}
        </span>
      </div>
      <ul className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-4">
        {visible.map((d) => (
          <li key={d.dealId}>
            <Link
              href={`/app/deals/${d.dealId}`}
              className="hover-lift flex flex-col gap-0.5 rounded-md border border-line-soft bg-surface-2/40 px-3 py-2 text-xs transition-colors hover:bg-surface-2/60"
            >
              <div className="flex items-center gap-2">
                <span className="num-mono font-semibold text-text-primary">
                  {d.dealRef}
                </span>
                <span className="rounded bg-surface-2 px-1 py-0 text-[10px] uppercase tracking-wider2 text-text-muted">
                  {d.role}
                </span>
              </div>
              <div className="truncate text-text-secondary">
                {d.product.replace(/_/g, " ")} ·{" "}
                <span className="num">{formatVolumeShort(d.volumeUsg)}</span>
              </div>
              <div className="text-[10px] text-text-muted">
                {d.status.replace(/_/g, " ")}
              </div>
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}

function totalRoleCount(rc: OrgPulse["roleCounts"]): number {
  return rc.buyer + rc.supplier + rc.broker + rc.intermediary;
}

function formatVolumeShort(usg: number): string {
  if (!usg) return "0";
  if (usg >= 1_000_000) return `${(usg / 1_000_000).toFixed(1)}M`;
  if (usg >= 1_000) return `${(usg / 1_000).toFixed(0)}k`;
  return String(usg);
}

function ofacShort(status: string): string {
  switch (status) {
    case "clear":
      return "Clear";
    case "unscreened":
      return "Unscreened";
    case "potential_match":
      return "Potential";
    case "confirmed_match":
      return "Match";
    case "cleared_by_operator":
      return "Cleared";
    default:
      return status;
  }
}

function ofacTone(
  status: string | undefined,
): "good" | "warn" | "bad" | undefined {
  if (!status) return undefined;
  if (status === "clear" || status === "cleared_by_operator") return "good";
  if (status === "unscreened") return "warn";
  if (status === "potential_match" || status === "confirmed_match")
    return "bad";
  return undefined;
}

function riskTierLabel(tier: string): string {
  switch (tier) {
    case "tier_1":
      return "Tier 1";
    case "tier_2":
      return "Tier 2";
    case "tier_3":
      return "Tier 3";
    case "watch":
      return "Watch";
    case "declined":
      return "Declined";
    default:
      return tier;
  }
}

function riskTone(
  tier: string | null | undefined,
): "good" | "warn" | "bad" | undefined {
  if (!tier) return undefined;
  if (tier === "tier_1" || tier === "tier_2") return "good";
  if (tier === "tier_3" || tier === "watch") return "warn";
  if (tier === "declined") return "bad";
  return undefined;
}
