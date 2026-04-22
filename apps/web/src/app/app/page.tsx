"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { WorkspaceMode } from "@vex/ui";
import type { BriefPriority, DailyBrief } from "@vex/domain";
import {
  WorkspaceModeProvider,
  useWorkspaceMode,
} from "@/lib/workspace-mode-context";
import { PriorityCard } from "@/components/brief/priority-card";
import { HeadsUpStrip } from "@/components/brief/heads-up-strip";
import { HotLeadsCard } from "@/components/brief/hot-leads-card";
import { DealPipelineRow } from "@/components/brief/deal-pipeline-row";
import { BlockedCard, RiskCard } from "@/components/brief/blocked-card";
import { fetchWithRetry } from "@/lib/fetch-with-retry";

/**
 * /app home — daily brief. Depends on PriorityCard (B-4),
 * DealPipelineRow (B-5), BlockedCard + RiskCard (B-6); imports fail
 * to resolve until those land. Polling uses plain fetch +
 * setInterval (5m) — no SWR dependency in the web graph.
 * Wraps itself in WorkspaceModeProvider since /app/layout.tsx hasn't
 * landed; nested providers inner-win, so this merges cleanly later.
 */

const POLL_INTERVAL_MS = 5 * 60 * 1000;
const PRIORITIES_COLLAPSED = 5;
const PIPELINE_COLLAPSED = 4;
const HANDLED_COLLAPSED = 3;
const TOP_ACTIONS_COUNT = 3;

interface BriefNotReady {
  status: "not_ready";
  message: string;
}

function isNotReady(b: unknown): b is BriefNotReady {
  return (
    typeof b === "object" &&
    b !== null &&
    "status" in b &&
    (b as { status?: unknown }).status === "not_ready"
  );
}

/** Cap the per-tick wait so a stuck upstream can't strand the home page on skeletons. */
const BRIEF_FETCH_TIMEOUT_MS = 10_000;

function useDailyBrief() {
  const [brief, setBrief] = useState<DailyBrief | null>(null);
  const [notReady, setNotReady] = useState<BriefNotReady | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    let cancelled = false;
    const tick = async (): Promise<void> => {
      const controller = new AbortController();
      const timeout = setTimeout(
        () => controller.abort(),
        BRIEF_FETCH_TIMEOUT_MS,
      );
      try {
        const res = await fetchWithRetry("/api/brief/today", {
          credentials: "include",
          cache: "no-store",
          signal: controller.signal,
        });
        if (res.status === 502 || res.status === 503) {
          throw new Error("API is waking up — retry in a moment.");
        }
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = (await res.json()) as unknown;
        if (cancelled) return;
        if (isNotReady(data)) {
          setNotReady(data);
          setBrief(null);
        } else {
          setBrief(data as DailyBrief);
          setNotReady(null);
        }
        setError(null);
      } catch (e) {
        if (cancelled) return;
        const err = e as Error;
        setError(
          err.name === "AbortError"
            ? "Brief request timed out — the API may be warming up."
            : err.message,
        );
      } finally {
        clearTimeout(timeout);
        if (!cancelled) setLoading(false);
      }
    };
    void tick();
    const interval = setInterval(() => void tick(), POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, []);
  return { brief, notReady, error, loading };
}

export default function AppHome() {
  return (
    <WorkspaceModeProvider>
      <AppHomeInner />
    </WorkspaceModeProvider>
  );
}

function AppHomeInner() {
  const { setMode } = useWorkspaceMode();
  const { brief, notReady, error, loading } = useDailyBrief();
  const [showAllPriorities, setShowAllPriorities] = useState(false);
  const [showHandled, setShowHandled] = useState(false);

  useEffect(() => {
    setMode(WorkspaceMode.MorningBrief);
  }, [setMode]);

  const visiblePriorities = useMemo(
    () =>
      !brief
        ? []
        : showAllPriorities
          ? brief.priorities
          : brief.priorities.slice(0, PRIORITIES_COLLAPSED),
    [brief, showAllPriorities],
  );
  const visiblePipeline = useMemo(
    () => (brief ? brief.pipeline.slice(0, PIPELINE_COLLAPSED) : []),
    [brief],
  );
  // Top actions are the most urgent priorities surfaced above the
  // hero as a compact row — operator lands on /app and sees
  // "here are the 3 things to do first" without scrolling through
  // five sections. High-urgency items win; fall back to whatever's
  // at the top of the list so the strip always populates when there
  // are priorities at all.
  const topActions = useMemo(() => {
    if (!brief) return [];
    const ranked = [...brief.priorities].sort((a, b) => {
      const w = (p: typeof a) =>
        p.urgency === "high" ? 0 : p.urgency === "medium" ? 1 : 2;
      return w(a) - w(b);
    });
    return ranked.slice(0, TOP_ACTIONS_COUNT);
  }, [brief]);
  const visibleHandled = useMemo(() => {
    if (!brief) return [];
    return showHandled
      ? brief.handled
      : brief.handled.slice(0, HANDLED_COLLAPSED);
  }, [brief, showHandled]);

  if (loading) return <HomeSkeleton />;
  if (notReady) return <NotReadyState message={notReady.message} />;
  if (!brief)
    return <NotReadyState message={error ?? "Brief unavailable."} />;

  return (
    <main className="mx-auto max-w-5xl space-y-8 px-8 py-10 text-white">
      <Hero brief={brief} />
      {brief.recommendedFocus ? (
        <FocusBand focus={brief.recommendedFocus} />
      ) : null}
      {topActions.length > 0 ? (
        <TopActionsStrip priorities={topActions} />
      ) : null}
      <HeadsUpStrip />
      <HotLeadsCard />
      {brief.priorities.length > 0 && (
        <Section title="Needs your attention" count={brief.priorities.length}>
          <div className="space-y-3">
            {visiblePriorities.map((p) => (
              <PriorityCard key={p.id} priority={p} />
            ))}
          </div>
          {brief.priorities.length > PRIORITIES_COLLAPSED && (
            <button
              type="button"
              onClick={() => setShowAllPriorities((v) => !v)}
              className="mt-3 text-xs text-white/50 hover:text-white/80"
            >
              {showAllPriorities
                ? "Show less"
                : `Show all (${brief.priorities.length})`}
            </button>
          )}
        </Section>
      )}
      {brief.pipeline.length > 0 && (
        <Section title="Deal pipeline">
          <div className="divide-y divide-line/60 rounded-lg border border-line bg-muted/20">
            {visiblePipeline.map((d) => (
              <DealPipelineRow key={d.dealId} deal={d} />
            ))}
          </div>
          {brief.pipeline.length > PIPELINE_COLLAPSED && (
            <Link
              href="/app/deals"
              className="mt-3 inline-block text-xs text-white/50 hover:text-white/80"
            >
              View all deals →
            </Link>
          )}
        </Section>
      )}
      {brief.handled.length > 0 && (
        <Section title="Vex handled" count={brief.handled.length} dim>
          <ul className="space-y-1">
            {visibleHandled.map((h) => (
              <li
                key={h.id}
                className="flex items-center gap-3 rounded-md border border-line/50 bg-muted/10 px-2 py-1.5 text-xs text-white/70"
              >
                <span className="inline-block h-1.5 w-1.5 flex-shrink-0 rounded-full bg-emerald-400" />
                <span className="rounded bg-white/10 px-1.5 py-0.5 font-medium text-white/90">
                  {h.agentName}
                </span>
                <span className="min-w-0 flex-1 truncate">{h.summary}</span>
                <span className="text-white/40">
                  ${h.costUsd.toFixed(2)}
                </span>
              </li>
            ))}
          </ul>
          {brief.handled.length > HANDLED_COLLAPSED && (
            <button
              type="button"
              onClick={() => setShowHandled((v) => !v)}
              aria-expanded={showHandled}
              className="mt-2 text-xs text-white/50 hover:text-white/80"
            >
              {showHandled
                ? "Show less"
                : `Show ${brief.handled.length - HANDLED_COLLAPSED} more`}
            </button>
          )}
        </Section>
      )}
      {brief.blocked.length > 0 && (
        <Section title="Blocked" tone="warning">
          <div className="space-y-3">
            {brief.blocked.map((b) => (
              <BlockedCard key={b.id} item={b} />
            ))}
          </div>
        </Section>
      )}
      {brief.risks.length > 0 && (
        <Section title="Watch" tone="attention">
          <div className="space-y-3">
            {brief.risks.map((r) => (
              <RiskCard key={r.id} risk={r} />
            ))}
          </div>
        </Section>
      )}
    </main>
  );
}

// ---------------------------------------------------------------------------
// Small presentational helpers — kept in this file so /app/page.tsx is
// self-contained and ~300 lines end to end. Hero / Section / Focus
// are specific to the brief layout; skeleton + not-ready cover the
// loading and empty states.
// ---------------------------------------------------------------------------

function Hero({ brief }: { brief: DailyBrief }) {
  const generatedAt = new Date(brief.generatedAt);
  return (
    <section className="flex flex-wrap items-start justify-between gap-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight text-white">
          {brief.greeting}
        </h1>
        <p className="mt-1 text-xs text-white/40">
          Updated{" "}
          {generatedAt.toLocaleTimeString(undefined, {
            hour: "numeric",
            minute: "2-digit",
          })}
        </p>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <StatPill
          label={`${brief.pendingApprovalCount} pending approval${brief.pendingApprovalCount === 1 ? "" : "s"}`}
          tone={brief.pendingApprovalCount > 0 ? "warning" : "neutral"}
        />
        <StatPill
          label={`$${brief.totalAgentCostToday.toFixed(2)} spent today by Vex`}
          tone="neutral"
        />
      </div>
    </section>
  );
}

function StatPill({
  label,
  tone,
}: {
  label: string;
  tone: "warning" | "neutral";
}) {
  const toneClass =
    tone === "warning"
      ? "border-amber-500/60 bg-amber-500/10 text-amber-200"
      : "border-line bg-muted/40 text-white/70";
  return (
    <span
      className={`rounded-full border px-3 py-1 text-xs ${toneClass}`}
    >
      {label}
    </span>
  );
}

function Section({
  title,
  count,
  tone,
  dim,
  children,
}: {
  title: string;
  count?: number;
  tone?: "attention" | "warning";
  dim?: boolean;
  children: React.ReactNode;
}) {
  const headerTone =
    tone === "attention"
      ? "text-red-300"
      : tone === "warning"
        ? "text-amber-300"
        : dim
          ? "text-white/40"
          : "text-white";
  return (
    <section>
      <header className="mb-3 flex items-baseline gap-2">
        <h2 className={`text-sm font-semibold uppercase tracking-wider ${headerTone}`}>
          {title}
        </h2>
        {typeof count === "number" && (
          <span className="text-xs text-white/40">· {count}</span>
        )}
      </header>
      {children}
    </section>
  );
}

/**
 * Promoted focus line. Was a footer at the very bottom of the page,
 * which most operators never scrolled to. Now sits directly under
 * the hero as the first piece of guidance Vex offers before any
 * lists load — clickable into chat so the operator can immediately
 * dig in or redirect.
 */
function FocusBand({ focus }: { focus: string }) {
  const ask = `Walk me through today's focus: ${focus}`;
  return (
    <Link
      href={`/app/chat?ask=${encodeURIComponent(ask)}`}
      className="flex items-start gap-3 rounded-lg border border-teal-400/40 bg-teal-400/10 px-5 py-4 text-sm text-white/90 transition-colors hover:bg-teal-400/15"
    >
      <span className="mt-0.5 flex-shrink-0 rounded bg-teal-400/25 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-teal-100">
        Focus
      </span>
      <span className="flex-1 leading-snug">{focus}</span>
      <span className="mt-0.5 flex-shrink-0 text-teal-300">→</span>
    </Link>
  );
}

/**
 * Top-of-page strip showing the 1-3 most urgent priorities, each as
 * an at-a-glance pill that the operator can act on without scrolling
 * into the full Needs-your-attention list. Mirrors the primary
 * action the PriorityCard would expose — approval first, then detail
 * page, then Ask Vex fallback.
 */
function TopActionsStrip({
  priorities,
}: {
  priorities: BriefPriority[];
}) {
  return (
    <section aria-label="Top actions" className="flex flex-col gap-2">
      <div className="flex items-baseline gap-2">
        <h2 className="text-[11px] font-semibold uppercase tracking-wider text-white/60">
          Do first
        </h2>
        <span className="text-xs text-white/40">
          · {priorities.length} quick action{priorities.length === 1 ? "" : "s"}
        </span>
      </div>
      <ol className="grid grid-cols-1 gap-2 sm:grid-cols-3">
        {priorities.map((p, i) => (
          <TopActionPill key={p.id} index={i + 1} priority={p} />
        ))}
      </ol>
    </section>
  );
}

function TopActionPill({
  index,
  priority,
}: {
  index: number;
  priority: BriefPriority;
}) {
  const toneBorder =
    priority.urgency === "high"
      ? "border-red-500/60 bg-red-500/5"
      : priority.urgency === "medium"
        ? "border-amber-500/60 bg-amber-500/5"
        : "border-line bg-muted/30";
  const href = priority.approvalId
    ? `/app/approvals/${priority.approvalId}`
    : priority.objectType === "deal"
      ? `/app/deals/${priority.objectId}`
      : priority.objectType === "organization"
        ? `/app/companies/${priority.objectId}`
        : priority.objectType === "contact"
          ? `/app/contacts/${priority.objectId}`
          : priority.objectType === "campaign"
            ? `/app/marketing/${priority.objectId}`
            : `/app/chat?ask=${encodeURIComponent(priority.suggestedAction ?? priority.title)}`;
  return (
    <li>
      <Link
        href={href}
        className={`flex h-full items-start gap-3 rounded-lg border px-3 py-2 transition-colors hover:bg-white/5 ${toneBorder}`}
      >
        <span className="mt-0.5 flex h-5 w-5 flex-shrink-0 items-center justify-center rounded-full border border-white/20 bg-canvas/60 font-mono text-[10px] text-white/60">
          {index}
        </span>
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-medium text-white">
            {priority.title}
          </div>
          <div className="mt-0.5 truncate text-xs text-white/50">
            {priority.reason}
          </div>
        </div>
      </Link>
    </li>
  );
}

function HomeSkeleton() {
  return (
    <main
      className="mx-auto max-w-5xl space-y-10 px-8 py-10 text-white"
      aria-busy="true"
    >
      <div className="space-y-3">
        <div className="h-6 w-2/3 rounded bg-white/10" />
        <div className="h-3 w-24 rounded bg-white/5" />
      </div>
      {[0, 1, 2].map((i) => (
        <div key={i} className="space-y-2">
          <div className="h-3 w-32 rounded bg-white/10" />
          <div className="h-20 w-full rounded bg-white/5" />
        </div>
      ))}
    </main>
  );
}

function NotReadyState({ message }: { message: string }) {
  return (
    <main className="mx-auto max-w-xl space-y-4 px-8 py-20 text-center text-white">
      <h1 className="text-xl font-semibold">Brief not ready</h1>
      <p className="text-sm text-white/60">{message}</p>
      <Link
        href="/app/chat"
        className="inline-block rounded-md border border-line bg-muted/40 px-4 py-2 text-sm text-white/80 transition hover:border-white/30 hover:text-white"
      >
        Ask Vex anything →
      </Link>
    </main>
  );
}
