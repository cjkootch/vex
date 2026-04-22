"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { formatDistanceToNow } from "date-fns";
import { WorkspaceMode } from "@vex/ui";
import {
  WorkspaceModeProvider,
  useWorkspaceMode,
} from "@/lib/workspace-mode-context";

/**
 * /app/calls — Sprint 12 outbound-call surface.
 *
 * Three sections:
 *   - Pending approval  (action_type='outbound_call', decision=pending)
 *   - Active            (agent_runs with agent_name='outbound_call'
 *                         status=pending/running)
 *   - Completed         (agent_runs with agent_name='outbound_call'
 *                         status=completed)
 *
 * Both data sources poll every 5s (spec). Poll stops when the tab is
 * backgrounded — Page Visibility API — so idle tabs don't burn
 * bandwidth.
 */

// 5s polling against /api/agent-runs + /api/approvals on every open
// /app/calls tab tripped the API throttle (429). 15s is plenty for a
// list view — the call detail page (where live-listen lives) has its
// own faster poll bound to a single workflow id.
const POLL_INTERVAL_MS = 15_000;
const CALLS_AGENT_NAME = "outbound_call";

interface AgentRunItem {
  id: string;
  agent_name: string;
  status: string;
  started_at: string | null;
  finished_at: string | null;
  cost_usd: number;
  error: string | null;
  has_approval: boolean;
  approval_status: string | null;
  summary: string;
}

interface ApprovalItem {
  id: string;
  actionType: string;
  decision: string;
  createdAt: string;
  agentRunId?: string | null;
  proposedPayload: Record<string, unknown>;
}

export default function CallsPage() {
  return (
    <WorkspaceModeProvider>
      <CallsPageInner />
    </WorkspaceModeProvider>
  );
}

function CallsPageInner() {
  const { setMode } = useWorkspaceMode();
  const { runs, approvals, loading, error } = useCallsData();

  useEffect(() => {
    // No explicit workspace mode for calls yet — fall back to Global so
    // the ContextChip stays neutral when AppShell is eventually wired.
    setMode(WorkspaceMode.Global);
  }, [setMode]);

  const pending = useMemo(
    () => approvals.filter((a) => a.actionType === "outbound_call"),
    [approvals],
  );
  const callRuns = useMemo(
    () => runs.filter((r) => r.agent_name === CALLS_AGENT_NAME),
    [runs],
  );
  const active = useMemo(
    () =>
      callRuns.filter(
        (r) => r.status === "running" || r.status === "pending",
      ),
    [callRuns],
  );
  const completed = useMemo(
    () => callRuns.filter((r) => r.status === "completed"),
    [callRuns],
  );
  const failed = useMemo(
    () => callRuns.filter((r) => r.status === "failed"),
    [callRuns],
  );

  return (
    <main className="mx-auto max-w-5xl space-y-8 px-8 py-10">
      <header className="flex flex-wrap items-start justify-between gap-4 border-b border-line-soft pb-5">
        <div>
          <div className="text-eyebrow text-text-muted">Outreach</div>
          <h1 className="mt-1 text-title text-text-primary">Calls</h1>
          <p className="mt-2 text-sm text-text-secondary">
            Outbound PSTN calls orchestrated by Vex. Every call requires a
            T3 approval before Twilio dials.
          </p>
        </div>
      </header>

      {error ? (
        <p className="text-sm text-red-400">
          Couldn&rsquo;t load calls: {error}
        </p>
      ) : null}

      {pending.length > 0 ? (
        <Section
          title="Awaiting approval"
          tone="warning"
          count={pending.length}
        >
          <div className="space-y-3">
            {pending.map((a) => (
              <PendingCallCard key={a.id} approval={a} />
            ))}
          </div>
        </Section>
      ) : null}

      {active.length > 0 ? (
        <Section title="In progress" tone="info" count={active.length}>
          <ul className="divide-y divide-line/60 rounded-lg border border-line bg-muted/20">
            {active.map((r) => (
              <ActiveRow key={r.id} run={r} />
            ))}
          </ul>
        </Section>
      ) : null}

      {completed.length > 0 ? (
        <Section title="Completed" count={completed.length}>
          <ul className="divide-y divide-line/60 rounded-lg border border-line bg-muted/20">
            {completed.map((r) => (
              <CompletedRow key={r.id} run={r} />
            ))}
          </ul>
        </Section>
      ) : null}

      {failed.length > 0 ? (
        <Section title="Failed" tone="danger" count={failed.length}>
          <ul className="divide-y divide-line/60 rounded-lg border border-line bg-muted/20">
            {failed.map((r) => (
              <CompletedRow key={r.id} run={r} />
            ))}
          </ul>
        </Section>
      ) : null}

      {loading &&
      pending.length === 0 &&
      active.length === 0 &&
      completed.length === 0 &&
      failed.length === 0 ? (
        <Skeleton />
      ) : null}

      {!loading &&
      pending.length === 0 &&
      active.length === 0 &&
      completed.length === 0 &&
      failed.length === 0 ? (
        <EmptyState />
      ) : null}
    </main>
  );
}

// ---------------------------------------------------------------------------
// Data hook — polls /api/agent-runs + /api/approvals every 5s; pauses when
// the tab is hidden to avoid running a background burn.
// ---------------------------------------------------------------------------

function useCallsData(): {
  runs: AgentRunItem[];
  approvals: ApprovalItem[];
  loading: boolean;
  error: string | null;
} {
  const [runs, setRuns] = useState<AgentRunItem[]>([]);
  const [approvals, setApprovals] = useState<ApprovalItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const tick = async (): Promise<void> => {
      try {
        const [runsRes, approvalsRes] = await Promise.all([
          fetch("/api/agent-runs?limit=50", {
            credentials: "include",
            cache: "no-store",
          }),
          fetch("/api/approvals?status=pending", {
            credentials: "include",
            cache: "no-store",
          }),
        ]);
        if (!runsRes.ok) throw new Error(`agent-runs HTTP ${runsRes.status}`);
        if (!approvalsRes.ok)
          throw new Error(`approvals HTTP ${approvalsRes.status}`);
        const runsBody = (await runsRes.json()) as {
          runs?: AgentRunItem[];
        };
        const approvalsBody = (await approvalsRes.json()) as {
          approvals?: ApprovalItem[];
        };
        if (cancelled) return;
        setRuns(Array.isArray(runsBody.runs) ? runsBody.runs : []);
        setApprovals(
          Array.isArray(approvalsBody.approvals) ? approvalsBody.approvals : [],
        );
        setError(null);
      } catch (e) {
        if (cancelled) return;
        setError((e as Error).message);
      } finally {
        if (!cancelled) setLoading(false);
      }
    };

    void tick();
    let interval: ReturnType<typeof setInterval> | null = setInterval(
      () => void tick(),
      POLL_INTERVAL_MS,
    );

    // Pause polling when the tab is hidden; resume + refresh on show.
    const onVisibility = (): void => {
      if (document.visibilityState === "hidden") {
        if (interval !== null) {
          clearInterval(interval);
          interval = null;
        }
      } else {
        void tick();
        if (interval === null) {
          interval = setInterval(() => void tick(), POLL_INTERVAL_MS);
        }
      }
    };
    document.addEventListener("visibilitychange", onVisibility);

    return () => {
      cancelled = true;
      if (interval !== null) clearInterval(interval);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, []);

  return { runs, approvals, loading, error };
}

// ---------------------------------------------------------------------------
// Presentational helpers
// ---------------------------------------------------------------------------

function Section({
  title,
  tone,
  count,
  children,
}: {
  title: string;
  tone?: "warning" | "info" | "danger";
  count?: number;
  children: React.ReactNode;
}) {
  const toneClass =
    tone === "warning"
      ? "text-amber-300"
      : tone === "info"
        ? "text-blue-300"
        : tone === "danger"
          ? "text-red-300"
          : "text-white";
  return (
    <section>
      <header className="mb-3 flex items-baseline gap-2">
        <h2
          className={`text-sm font-semibold uppercase tracking-wider ${toneClass}`}
        >
          {title}
        </h2>
        {typeof count === "number" ? (
          <span className="text-xs text-white/40">· {count}</span>
        ) : null}
      </header>
      {children}
    </section>
  );
}

function PendingCallCard({ approval }: { approval: ApprovalItem }) {
  const payload = approval.proposedPayload ?? {};
  const to =
    typeof payload["to_number"] === "string"
      ? (payload["to_number"] as string)
      : "(number hidden)";
  const contactId =
    typeof payload["contact_id"] === "string"
      ? (payload["contact_id"] as string)
      : "";
  const initiator =
    typeof payload["initiated_by"] === "string"
      ? (payload["initiated_by"] as string)
      : "unknown";
  return (
    <article className="rounded-lg border border-amber-500/50 bg-amber-500/5 p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <h3 className="font-semibold text-white">Outbound call to {to}</h3>
          <p className="mt-1 text-xs text-white/60">
            Queued{" "}
            {formatDistanceToNow(new Date(approval.createdAt), {
              addSuffix: true,
            })}{" "}
            by {initiator}
            {contactId ? ` · contact ${contactId}` : ""}
          </p>
        </div>
        <Link
          href="/app/approvals"
          className="rounded-md border border-amber-500/50 bg-amber-500/10 px-3 py-1.5 text-xs text-amber-200 transition hover:bg-amber-500/20"
        >
          Review approval
        </Link>
      </div>
    </article>
  );
}

function ActiveRow({ run }: { run: AgentRunItem }) {
  return (
    <li className="flex items-center gap-4 px-4 py-3 text-sm">
      <span
        aria-hidden="true"
        className="h-2 w-2 flex-shrink-0 rounded-full bg-blue-400 animate-pulse"
      />
      <div className="min-w-0 flex-1">
        <div className="truncate text-white">{run.summary}</div>
        <div className="text-xs text-white/40">
          Started{" "}
          {run.started_at
            ? formatDistanceToNow(new Date(run.started_at), {
                addSuffix: true,
              })
            : "(pending)"}
        </div>
      </div>
      <span className="rounded-full border border-blue-400/40 bg-blue-500/10 px-2 py-0.5 text-xs text-blue-200">
        {run.status}
      </span>
      <Link
        href={`/app/calls/${encodeURIComponent(`outbound-call-${run.id}`)}`}
        className="text-xs text-white/60 hover:text-white"
      >
        Details →
      </Link>
    </li>
  );
}

function CompletedRow({ run }: { run: AgentRunItem }) {
  const tone = run.status === "completed" ? "emerald" : "red";
  return (
    <li className="flex items-center gap-4 px-4 py-3 text-sm">
      <span
        aria-hidden="true"
        className={`h-2 w-2 flex-shrink-0 rounded-full ${
          tone === "emerald" ? "bg-emerald-400" : "bg-red-500"
        }`}
      />
      <div className="min-w-0 flex-1">
        <div className="truncate text-white">{run.summary}</div>
        <div className="text-xs text-white/40">
          {run.finished_at
            ? `Finished ${formatDistanceToNow(new Date(run.finished_at), { addSuffix: true })}`
            : "Finished"}
          {" · "}
          cost ${run.cost_usd.toFixed(2)}
        </div>
      </div>
      <Link
        href={`/app/calls/${encodeURIComponent(run.id)}/transcript`}
        className="text-xs text-white/60 hover:text-white"
      >
        Transcript →
      </Link>
    </li>
  );
}

function EmptyState() {
  return (
    <section className="rounded-lg border border-line bg-muted/20 px-6 py-8">
      <h2 className="text-base font-semibold text-white">No outbound calls yet</h2>
      <p className="mt-2 text-sm text-white/70">
        Calls are queued from a specific contact. Open a contact in{" "}
        <Link href="/app/contacts" className="text-accent hover:underline">
          Contacts
        </Link>{" "}
        and click <span className="font-mono text-white">Call</span> on
        their profile, or just ask in{" "}
        <Link href="/app/chat" className="text-accent hover:underline">
          Chat
        </Link>{" "}
        — &ldquo;call Cole Kutschinski&rdquo; queues a T3 approval the
        same way.
      </p>

      <div className="mt-5 grid gap-3 text-sm sm:grid-cols-2">
        <div className="rounded-md border border-line bg-canvas/40 p-3">
          <div className="mb-1 text-[10px] uppercase tracking-wider text-accent">
            AI dials
          </div>
          <p className="text-white/80">
            <span className="font-semibold text-white">Vex calls.</span>{" "}
            Twilio dials the contact and OpenAI Realtime holds the
            conversation using the qualifier prompt (or a custom one if
            you supplied <code className="font-mono">aiInstructions</code>).
            You can listen in or unmute to take over from the call
            detail page.
          </p>
        </div>
        <div className="rounded-md border border-line bg-canvas/40 p-3">
          <div className="mb-1 text-[10px] uppercase tracking-wider text-white/60">
            Operator joins
          </div>
          <p className="text-white/80">
            <span className="font-semibold text-white">You call.</span>{" "}
            Twilio dials the contact and bridges the call into a
            conference. Open the detail page → <em>Join call</em> to
            speak with them. Vex stays available to assist via the
            transcript or hand-off.
          </p>
        </div>
      </div>

      <p className="mt-4 text-xs text-white/40">
        Either way, every call requires a T3 approval before Twilio
        dials. Make sure <code className="font-mono">outbound_call</code>{" "}
        is in your workspace&rsquo;s <code className="font-mono">enabled_agents</code>.
      </p>
    </section>
  );
}

function Skeleton() {
  return (
    <div className="space-y-3" aria-busy="true">
      {[0, 1, 2].map((i) => (
        <div
          key={i}
          className="h-16 w-full rounded-lg border border-line bg-muted/20"
        />
      ))}
    </div>
  );
}
