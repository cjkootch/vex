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

function useDailyBrief() {
  const [brief, setBrief] = useState<DailyBrief | null>(null);
  const [notReady, setNotReady] = useState<BriefNotReady | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    let cancelled = false;
    const tick = async (): Promise<void> => {
      try {
        const res = await fetch("/api/brief/today", {
          credentials: "include",
          cache: "no-store",
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
        setError((e as Error).message);
      } finally {
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
