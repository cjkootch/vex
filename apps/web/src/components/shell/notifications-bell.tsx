"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";

// Inline Icon matches the private Icon in app-shell.tsx. Kept local so
// this component is drop-in without touching the shell's module graph.
function Icon({ path, size = 5 }: { path: string; size?: 4 | 5 }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.75}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={`${size === 4 ? "h-4 w-4" : "h-5 w-5"} flex-shrink-0`}
      aria-hidden="true"
    >
      <path d={path} />
    </svg>
  );
}

interface HotLead {
  event_id: string;
  occurred_at: string;
  lead_id: string;
  contact_id: string | null;
  contact_name: string | null;
  org_name: string | null;
  buying_intent: string | null;
  urgency: string | null;
  product: string | null;
  volume: string | null;
  destination: string | null;
  timeline: string | null;
  summary: string | null;
}

interface HotLeadsResponse {
  hot: HotLead[];
  window_days: number;
}

const POLL_MS = 60_000;
const LAST_SEEN_KEY = "vex.notifications.lastSeenAt";

/**
 * Bell dropdown in the app-shell header.
 *
 * Polls `/api/leads/hot` every 60s. The red badge counts leads whose
 * `occurred_at` is newer than the localStorage "last seen" timestamp.
 * Clicking the bell opens the dropdown AND resets last-seen → badge
 * clears. So the bell only screams about genuinely-new signals; you
 * won't re-see a lead you've already acknowledged.
 *
 * Current notification type: hot leads. Future types (follow-ups due,
 * approvals awaiting, deal milestones) can extend the same surface by
 * mixing in other event verbs or dedicated endpoints.
 */
export function NotificationsBell() {
  const [data, setData] = useState<HotLeadsResponse | null>(null);
  const [open, setOpen] = useState(false);
  const [lastSeenAt, setLastSeenAt] = useState<number>(0);
  const dropdownRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const raw = typeof window !== "undefined"
      ? window.localStorage.getItem(LAST_SEEN_KEY)
      : null;
    setLastSeenAt(raw ? Number(raw) || 0 : 0);
  }, []);

  useEffect(() => {
    let cancelled = false;
    const tick = async () => {
      try {
        const res = await fetch("/api/leads/hot?days=7&limit=20");
        if (!res.ok) return;
        const body = (await res.json()) as HotLeadsResponse;
        if (!cancelled) setData(body);
      } catch {
        // network blip — keep the last good snapshot, try again next tick
      }
    };
    tick();
    const t = window.setInterval(tick, POLL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(t);
    };
  }, []);

  useEffect(() => {
    if (!open) return;
    const onClick = (e: MouseEvent) => {
      if (!dropdownRef.current) return;
      if (!dropdownRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("mousedown", onClick);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onClick);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const unreadCount = (data?.hot ?? []).filter(
    (h) => new Date(h.occurred_at).getTime() > lastSeenAt,
  ).length;

  const handleToggle = useCallback(() => {
    setOpen((v) => {
      const next = !v;
      if (next) {
        const now = Date.now();
        setLastSeenAt(now);
        try {
          window.localStorage.setItem(LAST_SEEN_KEY, String(now));
        } catch {
          // private-mode / quota — non-fatal, badge just won't persist
        }
      }
      return next;
    });
  }, []);

  const rows = data?.hot ?? [];

  return (
    <div className="relative" ref={dropdownRef}>
      <button
        type="button"
        onClick={handleToggle}
        aria-label={
          unreadCount === 0
            ? "Notifications — no new hot leads"
            : `Notifications — ${unreadCount} new hot lead${unreadCount === 1 ? "" : "s"}`
        }
        className="relative inline-flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full border border-line bg-muted/40 text-white/70 transition hover:border-white/30 hover:text-white"
      >
        <Icon
          path="M15 17h5l-1.405-1.405A2.032 2.032 0 0118 14.158V11a6 6 0 10-12 0v3.159c0 .538-.214 1.055-.595 1.436L4 17h5m6 0v1a3 3 0 11-6 0v-1m6 0H9"
          size={5}
        />
        {unreadCount > 0 ? (
          <span
            aria-hidden="true"
            className="absolute -right-0.5 -top-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-red-500 px-1 text-[10px] font-semibold text-white"
          >
            {unreadCount > 9 ? "9+" : unreadCount}
          </span>
        ) : null}
      </button>

      {open ? (
        <div
          role="menu"
          className="absolute right-0 top-10 z-50 w-[22rem] max-w-[92vw] overflow-hidden rounded-lg border border-line bg-bg/95 shadow-xl backdrop-blur"
        >
          <div className="flex items-center justify-between border-b border-line/70 px-4 py-2">
            <h3 className="text-sm font-semibold text-white">
              Notifications
            </h3>
            <span className="text-xs text-white/40">
              {rows.length === 0
                ? "none"
                : `${rows.length} in last ${data?.window_days ?? 7}d`}
            </span>
          </div>
          {rows.length === 0 ? (
            <div className="px-4 py-6 text-center text-sm text-white/50">
              No hot leads yet. New qualifications with intent-to-buy
              or immediate urgency will land here.
            </div>
          ) : (
            <ul className="max-h-[60vh] divide-y divide-line/50 overflow-auto">
              {rows.map((lead) => (
                <BellRow
                  key={lead.event_id}
                  lead={lead}
                  isNew={new Date(lead.occurred_at).getTime() > lastSeenAt}
                  onClick={() => setOpen(false)}
                />
              ))}
            </ul>
          )}
          <div className="border-t border-line/70 px-4 py-2 text-right">
            <Link
              href="/app"
              onClick={() => setOpen(false)}
              className="text-xs text-white/60 transition hover:text-white"
            >
              View all on Brief →
            </Link>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function BellRow({
  lead,
  isNew,
  onClick,
}: {
  lead: HotLead;
  isNew: boolean;
  onClick: () => void;
}) {
  const href = lead.contact_id
    ? `/app/contacts/${lead.contact_id}`
    : "/app/signals";
  const age = relativeTime(new Date(lead.occurred_at));
  const subtitle = [
    lead.org_name,
    lead.product
      ? `${lead.product}${lead.volume ? ` · ${lead.volume}` : ""}`
      : null,
    lead.destination,
    lead.timeline,
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <li>
      <Link
        href={href}
        onClick={onClick}
        className="flex items-start gap-3 px-4 py-3 transition hover:bg-white/5"
      >
        <span
          aria-hidden="true"
          className={`mt-1.5 h-2 w-2 flex-shrink-0 rounded-full ${isNew ? "bg-red-500" : "bg-transparent"}`}
        />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <p className="truncate text-sm font-medium text-white">
              🔥 {lead.contact_name ?? "Unnamed contact"}
            </p>
            {lead.urgency === "immediate" ? (
              <span className="rounded-full border border-red-500/40 bg-red-500/20 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-red-100">
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
        <p className="shrink-0 pt-0.5 text-xs text-white/40">{age}</p>
      </Link>
    </li>
  );
}

function relativeTime(d: Date): string {
  const diff = Date.now() - d.getTime();
  if (diff < 60_000) return "now";
  if (diff < 60 * 60_000) return `${Math.floor(diff / 60_000)}m`;
  if (diff < 24 * 60 * 60_000) return `${Math.floor(diff / (60 * 60_000))}h`;
  return `${Math.floor(diff / (24 * 60 * 60_000))}d`;
}
