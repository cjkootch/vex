"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

/**
 * Compact 4-tile strip that lives above the daily brief hero and
 * surfaces the workspace's live pulse: open signals, overdue
 * follow-ups, pending approvals, open deals. Tiles poll every 60s
 * and deep-link to their respective pages. Numbers stay warm even
 * when the daily brief is hours old.
 */
interface Counts {
  signals: number;
  overdueFollowUps: number;
  approvals: number;
  openDeals: number;
}

export function HeadsUpStrip(): React.ReactElement {
  const [counts, setCounts] = useState<Counts>({
    signals: 0,
    overdueFollowUps: 0,
    approvals: 0,
    openDeals: 0,
  });

  useEffect(() => {
    let cancelled = false;
    const tick = async (): Promise<void> => {
      const [signalsRes, followUpsRes, approvalsRes, dealsRes] =
        await Promise.all([
          fetch("/api/signals").catch(() => null),
          fetch("/api/follow-ups?status=open").catch(() => null),
          fetch("/api/approvals?status=pending").catch(() => null),
          fetch("/api/deals").catch(() => null),
        ]);
      if (cancelled) return;
      const signalsCount = await safeJsonCount(signalsRes, "signals");
      const followUpsBody = (await safeJsonBody(followUpsRes)) as
        | {
            followUps?: Array<{ dueAt: string }>;
            follow_ups?: Array<{ dueAt: string }>;
          }
        | null;
      const followUpRows =
        followUpsBody?.followUps ?? followUpsBody?.follow_ups ?? [];
      const now = Date.now();
      const overdueCount = followUpRows.filter((r) => {
        const t = Date.parse(r.dueAt);
        return Number.isFinite(t) && t < now;
      }).length;
      const approvalsCount = await safeJsonCount(approvalsRes, "approvals");
      const dealsBody = (await safeJsonBody(dealsRes)) as
        | { deals?: Array<{ status: string }> }
        | null;
      const dealRows = dealsBody?.deals ?? [];
      const openStatuses = new Set([
        "draft",
        "negotiating",
        "pending_approval",
        "approved",
        "loading",
        "in_transit",
      ]);
      const openDealCount = dealRows.filter((d) =>
        openStatuses.has(d.status),
      ).length;
      setCounts({
        signals: signalsCount ?? 0,
        overdueFollowUps: overdueCount,
        approvals: approvalsCount ?? 0,
        openDeals: openDealCount,
      });
    };
    void tick();
    const interval = setInterval(() => void tick(), 60_000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, []);

  return (
    <section className="grid grid-cols-2 gap-2 md:grid-cols-4">
      <Tile
        href="/app/signals"
        label="Open signals"
        value={counts.signals}
        tone={counts.signals > 0 ? "warn" : "neutral"}
      />
      <Tile
        href="/app/follow-ups"
        label="Overdue follow-ups"
        value={counts.overdueFollowUps}
        tone={counts.overdueFollowUps > 0 ? "bad" : "neutral"}
      />
      <Tile
        href="/app/approvals"
        label="Pending approvals"
        value={counts.approvals}
        tone={counts.approvals > 0 ? "warn" : "neutral"}
      />
      <Tile
        href="/app/deals"
        label="Open deals"
        value={counts.openDeals}
        tone="neutral"
      />
    </section>
  );
}

function Tile({
  href,
  label,
  value,
  tone,
}: {
  href: string;
  label: string;
  value: number;
  tone: "neutral" | "warn" | "bad";
}): React.ReactElement {
  const border =
    tone === "bad"
      ? "border-red-500/40"
      : tone === "warn"
        ? "border-amber-400/40"
        : "border-line";
  const valueColor =
    tone === "bad"
      ? "text-red-300"
      : tone === "warn"
        ? "text-amber-300"
        : "text-white";
  return (
    <Link
      href={href}
      className={`flex flex-col justify-between rounded-lg border ${border} bg-muted/20 p-3 transition hover:bg-muted/40`}
    >
      <div className="text-[11px] uppercase tracking-wide text-white/50">
        {label}
      </div>
      <div
        className={`mt-2 font-mono text-2xl ${valueColor}`}
        data-testid={`tile-${label.replace(/\s+/g, "-").toLowerCase()}`}
      >
        {value}
      </div>
    </Link>
  );
}

async function safeJsonBody(res: Response | null): Promise<unknown> {
  if (!res || !res.ok) return null;
  try {
    return await res.json();
  } catch {
    return null;
  }
}

async function safeJsonCount(
  res: Response | null,
  arrayKey: string,
): Promise<number | null> {
  const body = (await safeJsonBody(res)) as
    | (Record<string, unknown> | null)
    | undefined;
  if (!body) return null;
  if (typeof body["count"] === "number") return body["count"];
  const arr = body[arrayKey];
  if (Array.isArray(arr)) return arr.length;
  return null;
}
