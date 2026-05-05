"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { formatDistanceToNow } from "date-fns";

/**
 * /app/hot — engagement-velocity ranking.
 *
 * Pulls /api/contacts/hot, renders one card per contact ordered by
 * score. The score formula lives server-side
 * (apps/api/src/contacts/contacts.service.ts) — this page is a thin
 * presentational wrapper. CTA on each card opens chat with a pre-
 * filled "draft a followup to {name}" so the operator goes from
 * scan → draft in one click.
 */

interface HotContact {
  contactId: string;
  contactName: string;
  contactTitle: string | null;
  orgId: string | null;
  orgName: string | null;
  score: number;
  recentSignalCounts: {
    count_24h: number;
    count_7d: number;
    count_30d: number;
  };
  latestSignal: {
    channel: string;
    occurredAt: string | null;
    preview: string | null;
  } | null;
  latestIntent: string | null;
  suggestedAction: string;
}

const REFRESH_MS = 60_000;

export default function HotPage(): React.ReactElement {
  const [hot, setHot] = useState<HotContact[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const res = await fetch("/api/contacts/hot?limit=20", {
        credentials: "include",
        cache: "no-store",
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = (await res.json()) as { hot: HotContact[] };
      setHot(body.hot ?? []);
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
    const id = setInterval(refresh, REFRESH_MS);
    return () => {
      clearInterval(id);
    };
  }, [refresh]);

  return (
    <main className="mx-auto max-w-4xl px-8 py-10 text-white">
      <header className="mb-6">
        <p className="text-xs uppercase tracking-wider text-white/50">
          Outreach
        </p>
        <h1 className="text-2xl font-semibold tracking-tight">Hot now</h1>
        <p className="mt-1 max-w-2xl text-sm text-white/60">
          Contacts ranked by recent engagement velocity. Higher scores
          mean more recent + more high-signal events (opens, clicks,
          replies, inbound messages, completed calls). Refreshes every
          minute.
        </p>
      </header>

      {error ? (
        <p className="mb-4 text-sm text-red-400" role="alert">
          {error}
        </p>
      ) : null}

      {loading && hot.length === 0 ? (
        <p className="text-sm text-white/40">Loading…</p>
      ) : hot.length === 0 ? (
        <div className="rounded-lg border border-line bg-muted/20 p-6 text-sm text-white/60">
          No contacts have shown engagement signals in the last 30
          days. Once recipients start opening / replying / clicking,
          they&apos;ll surface here.
        </div>
      ) : (
        <ul className="flex flex-col gap-3">
          {hot.map((c) => (
            <HotCard key={c.contactId} c={c} />
          ))}
        </ul>
      )}
    </main>
  );
}

function HotCard({ c }: { c: HotContact }): React.ReactElement {
  const draftHref = `/app/chat?seed=${encodeURIComponent(
    `draft a followup to ${c.contactName}`,
  )}`;
  return (
    <li className="rounded-lg border border-line bg-muted/20 px-4 py-3">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <Link
              href={`/app/contacts/${c.contactId}`}
              className="font-semibold text-white hover:underline"
            >
              {c.contactName}
            </Link>
            {c.contactTitle ? (
              <span className="text-xs text-white/50">· {c.contactTitle}</span>
            ) : null}
            {c.orgName ? (
              <Link
                href={c.orgId ? `/app/companies/${c.orgId}` : "#"}
                className="text-xs text-white/60 hover:underline"
              >
                · {c.orgName}
              </Link>
            ) : null}
            {c.latestIntent ? <IntentTag intent={c.latestIntent} /> : null}
          </div>

          <div className="mt-1.5 flex flex-wrap items-center gap-3 text-[11px] text-white/60">
            <span>
              <span className="font-mono text-white/40">24h:</span>{" "}
              {c.recentSignalCounts.count_24h}
            </span>
            <span>
              <span className="font-mono text-white/40">7d:</span>{" "}
              {c.recentSignalCounts.count_7d}
            </span>
            <span>
              <span className="font-mono text-white/40">30d:</span>{" "}
              {c.recentSignalCounts.count_30d}
            </span>
          </div>

          {c.latestSignal ? (
            <div className="mt-2 text-xs text-white/70">
              <span className="font-mono text-white/40">latest:</span>{" "}
              <span className="font-mono">{c.latestSignal.channel}</span>
              {c.latestSignal.occurredAt ? (
                <span className="text-white/40">
                  {" · "}
                  {formatDistanceToNow(new Date(c.latestSignal.occurredAt), {
                    addSuffix: true,
                  })}
                </span>
              ) : null}
              {c.latestSignal.preview ? (
                <p className="mt-1 truncate text-white/60">
                  &quot;{c.latestSignal.preview}&quot;
                </p>
              ) : null}
            </div>
          ) : null}

          <p className="mt-2 text-[11px] italic text-white/50">
            {c.suggestedAction}
          </p>
        </div>

        <div className="flex shrink-0 flex-col items-end gap-2">
          <span className="rounded-full bg-accent/15 px-2 py-0.5 font-mono text-xs text-accent">
            score {c.score}
          </span>
          <Link
            href={draftHref}
            className="rounded border border-accent/40 bg-accent/10 px-2 py-1 text-xs text-accent hover:bg-accent/20"
          >
            Draft followup →
          </Link>
        </div>
      </div>
    </li>
  );
}

function IntentTag({ intent }: { intent: string }): React.ReactElement {
  // Mirrors the palette in /app/inbox so the operator scans the same
  // tones across both surfaces.
  const palette: Record<string, string> = {
    interested: "bg-good/25 text-good",
    objection: "bg-warn/25 text-warn",
    unsubscribe: "bg-bad/25 text-bad",
    out_of_office: "bg-muted/60 text-white/60",
    confused: "bg-warn/15 text-warn",
    neutral: "bg-muted/60 text-white/70",
  };
  return (
    <span
      title={`intent_classifier label: ${intent}`}
      className={`rounded px-1.5 py-0.5 text-[10px] font-medium ${
        palette[intent] ?? "bg-muted/60 text-white/70"
      }`}
    >
      {intent.replace(/_/g, " ")}
    </span>
  );
}
