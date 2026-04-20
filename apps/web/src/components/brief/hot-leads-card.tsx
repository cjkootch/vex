"use client";

import { useEffect, useState } from "react";
import Link from "next/link";

interface HotLead {
  event_id: string;
  occurred_at: string;
  lead_id: string;
  contact_id: string | null;
  contact_name: string | null;
  contact_emails: string[];
  org_id: string | null;
  org_name: string | null;
  buying_intent: string | null;
  urgency: string | null;
  product: string | null;
  volume: string | null;
  destination: string | null;
  timeline: string | null;
  summary: string | null;
  source: string | null;
}

interface ApiResponse {
  hot: HotLead[];
  window_days: number;
}

const INITIAL_VISIBLE = 3;

/**
 * Sprint S.2 — Brief-page hot leads card. Shows the count of hot-
 * signal leads in the last 7 days, with the top 3 expanded and the
 * rest collapsible. Hot leads come from `lead.hot` events emitted
 * by the LeadQualificationAgent when buying_intent=intent_to_buy OR
 * urgency=immediate.
 *
 * If the list is empty, renders a quiet "no hot leads right now"
 * state so the card doesn't scream FALSE absence every time the
 * operator lands on /app.
 */
export function HotLeadsCard() {
  const [data, setData] = useState<ApiResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [expanded, setExpanded] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/leads/hot?days=7&limit=10");
        if (!res.ok) throw new Error(`GET /leads/hot → ${res.status}`);
        const body = (await res.json()) as ApiResponse;
        if (!cancelled) setData(body);
      } catch (err) {
        if (!cancelled) setError((err as Error).message);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  if (loading) {
    return (
      <section className="rounded-lg border border-line bg-muted/20 p-5 text-sm text-white/50">
        Loading hot leads…
      </section>
    );
  }

  if (error) {
    return (
      <section className="rounded-lg border border-red-500/30 bg-red-500/10 p-5 text-sm text-red-200">
        Hot leads unavailable: {error}
      </section>
    );
  }

  const count = data?.hot.length ?? 0;

  if (count === 0) {
    return (
      <section className="rounded-lg border border-line bg-muted/20 p-5">
        <Header count={0} windowDays={data?.window_days ?? 7} />
        <p className="mt-2 text-sm text-white/50">
          No hot leads right now. New qualifications with
          intent-to-buy or immediate urgency will land here.
        </p>
      </section>
    );
  }

  const visible = expanded ? data!.hot : data!.hot.slice(0, INITIAL_VISIBLE);

  return (
    <section className="rounded-lg border border-emerald-500/30 bg-emerald-500/5 p-5">
      <Header count={count} windowDays={data!.window_days} />
      <ul className="mt-4 divide-y divide-line/50">
        {visible.map((lead) => (
          <li key={lead.event_id} className="py-3">
            <HotLeadRow lead={lead} />
          </li>
        ))}
      </ul>
      {data!.hot.length > INITIAL_VISIBLE ? (
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          className="mt-1 text-xs text-white/60 transition hover:text-white"
        >
          {expanded
            ? "Show less"
            : `Show ${data!.hot.length - INITIAL_VISIBLE} more`}
        </button>
      ) : null}
    </section>
  );
}

function Header(props: { count: number; windowDays: number }) {
  return (
    <div className="flex items-start justify-between gap-4">
      <div>
        <h2 className="text-sm font-semibold text-white">
          Hot leads{" "}
          {props.count > 0 ? (
            <span className="ml-1 rounded-full border border-emerald-500/40 bg-emerald-500/20 px-2 py-0.5 text-xs font-medium text-emerald-200">
              {props.count}
            </span>
          ) : null}
        </h2>
        <p className="mt-0.5 text-xs text-white/50">
          Intent-to-buy or immediate signals in the last {props.windowDays} days.
        </p>
      </div>
    </div>
  );
}

function HotLeadRow({ lead }: { lead: HotLead }) {
  const age = relativeTime(new Date(lead.occurred_at));
  const subtitle = [
    lead.org_name,
    lead.product ? `${lead.product}${lead.volume ? ` · ${lead.volume}` : ""}` : null,
    lead.destination,
    lead.timeline,
  ]
    .filter(Boolean)
    .join(" · ");

  const href = lead.contact_id
    ? `/app/contacts/${lead.contact_id}`
    : `/app/signals`;

  const intentPill = lead.buying_intent === "intent_to_buy"
    ? "border-emerald-500/40 bg-emerald-500/20 text-emerald-100"
    : "border-amber-500/40 bg-amber-500/20 text-amber-100";
  const urgencyPill = lead.urgency === "immediate"
    ? "border-red-500/40 bg-red-500/20 text-red-100"
    : "border-line bg-muted/40 text-white/60";

  return (
    <Link
      href={href}
      className="block rounded-md px-2 py-1 -mx-2 transition hover:bg-white/5"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <p className="truncate text-sm font-medium text-white">
              {lead.contact_name ?? "Unnamed contact"}
            </p>
            {lead.buying_intent ? (
              <span
                className={`rounded-full border px-1.5 py-0.5 text-[10px] uppercase tracking-wide ${intentPill}`}
              >
                {lead.buying_intent.replace(/_/g, " ")}
              </span>
            ) : null}
            {lead.urgency === "immediate" ? (
              <span
                className={`rounded-full border px-1.5 py-0.5 text-[10px] uppercase tracking-wide ${urgencyPill}`}
              >
                immediate
              </span>
            ) : null}
          </div>
          {subtitle ? (
            <p className="mt-0.5 truncate text-xs text-white/60">{subtitle}</p>
          ) : null}
          {lead.summary ? (
            <p className="mt-1 line-clamp-2 text-xs text-white/70">
              {lead.summary}
            </p>
          ) : null}
        </div>
        <p className="shrink-0 text-xs text-white/40">{age}</p>
      </div>
    </Link>
  );
}

function relativeTime(d: Date): string {
  const diff = Date.now() - d.getTime();
  if (diff < 60_000) return "just now";
  if (diff < 60 * 60_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 24 * 60 * 60_000) return `${Math.floor(diff / (60 * 60_000))}h ago`;
  return `${Math.floor(diff / (24 * 60 * 60_000))}d ago`;
}
