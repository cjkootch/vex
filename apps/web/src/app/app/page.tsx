"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { WorkspaceMode } from "@vex/ui";
import type { DailyBrief } from "@vex/domain";
import {
  WorkspaceModeProvider,
  useWorkspaceMode,
} from "@/lib/workspace-mode-context";
import { PriorityCard } from "@/components/brief/priority-card";
import { DealPipelineRow } from "@/components/brief/deal-pipeline-row";
import { BlockedCard, RiskCard } from "@/components/brief/blocked-card";

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
        const res = await fetch("/api/brief/today", {
          credentials: "include",
          cache: "no-store",
          signal: controller.signal,
        });
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

  if (loading) return <HomeSkeleton />;
  if (notReady) return <NotReadyState message={notReady.message} />;
  if (!brief)
    return <NotReadyState message={error ?? "Brief unavailable."} />;

  return (
    <main className="mx-auto max-w-5xl space-y-10 px-8 py-10 text-white">
      <Hero brief={brief} />
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
          <button
            type="button"
            onClick={() => setShowHandled((v) => !v)}
            aria-expanded={showHandled}
            className="text-xs text-white/50 hover:text-white/80"
          >
            {showHandled
              ? "Hide"
              : `Show what Vex did (${brief.handled.length})`}
          </button>
          {showHandled && (
            <ul className="mt-3 space-y-1">
              {brief.handled.map((h) => (
                <li
                  key={h.id}
                  className="flex items-center gap-3 rounded-md px-2 py-1.5 text-xs text-white/60"
                >
                  <span className="rounded bg-white/10 px-1.5 py-0.5 text-white/80">
                    {h.agentName}
                  </span>
                  <span className="min-w-0 flex-1 truncate">{h.summary}</span>
                  <span className="text-white/30">
                    ${h.costUsd.toFixed(2)}
                  </span>
                </li>
              ))}
            </ul>
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
      <FocusFooter focus={brief.recommendedFocus} />
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

function FocusFooter({ focus }: { focus: string }) {
  if (!focus) return null;
  return (
    <footer className="rounded-lg border border-teal-400/40 bg-teal-400/5 px-5 py-4 text-sm text-white/80">
      <span className="mr-2 font-semibold uppercase tracking-wider text-teal-300">
        Focus
      </span>
      {focus}
    </footer>
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
