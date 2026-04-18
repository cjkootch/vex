"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";

/**
 * /app/calls/:id — Sprint I call detail surface.
 *
 * Polls /api/calls/:id every 2 seconds so the status + duration stay
 * current. The live duration ticks every second between polls so the
 * counter stays fluid even when the poll itself is slow.
 *
 * "Request backup" posts to /api/calls/:id/request-backup which
 * creates a T2 approval; the inbox renders a dedicated card (see
 * ApprovalsList in @/components/approvals). Join / live-listen are
 * Sprint J — the CTA today just deep-links the operator to the
 * approval surface.
 */

const POLL_MS = 2_000;
const TERMINAL_STATUSES = new Set([
  "completed",
  "canceled",
  "busy",
  "failed",
  "no-answer",
]);

interface CallDetail {
  workflowId: string;
  approval: { id: string; decision: string };
  activity: {
    id: string;
    callSid: string;
    status: string;
    durationSeconds: number | null;
    transcriptRef: string | null;
    startedAt: string;
  } | null;
  callee: {
    id: string;
    fullName: string | null;
    phone: string | null;
  } | null;
  workflow?: { status: string };
}

export default function CallDetailPage({
  params,
}: {
  params: { id: string };
}) {
  const [detail, setDetail] = useState<CallDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState<number>(() => Date.now());
  const [backupState, setBackupState] = useState<
    | { status: "idle" }
    | { status: "requesting" }
    | { status: "requested"; approvalId: string; existed: boolean }
    | { status: "error"; message: string }
  >({ status: "idle" });

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/calls/${params.id}`);
      if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
      const body = (await res.json()) as CallDetail;
      setDetail(body);
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    }
  }, [params.id]);

  useEffect(() => {
    void load();
  }, [load]);

  // Status poll — stops once the call reaches a terminal Twilio status
  // so we don't keep hitting the DB for a call that will never change.
  useEffect(() => {
    if (!detail) return;
    const twilioStatus = detail.activity?.status ?? "";
    if (TERMINAL_STATUSES.has(twilioStatus)) return;
    const id = window.setInterval(() => void load(), POLL_MS);
    return () => window.clearInterval(id);
  }, [detail, load]);

  // Live-tick clock — runs independently of the poll so the counter
  // stays smooth at 1Hz even when the poll is mid-flight.
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(id);
  }, []);

  const requestBackup = useCallback(async () => {
    setBackupState({ status: "requesting" });
    try {
      const res = await fetch(
        `/api/calls/${params.id}/request-backup`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({}),
        },
      );
      if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
      const body = (await res.json()) as { approvalId: string; existed: boolean };
      setBackupState({
        status: "requested",
        approvalId: body.approvalId,
        existed: body.existed,
      });
    } catch (err) {
      setBackupState({ status: "error", message: (err as Error).message });
    }
  }, [params.id]);

  if (error) {
    return (
      <div className="mx-auto max-w-3xl px-6 py-8">
        <Breadcrumb />
        <div className="mt-4 rounded-md border border-bad/40 bg-bad/10 px-3 py-2 text-sm text-bad">
          Couldn&apos;t load call: {error}
        </div>
      </div>
    );
  }
  if (!detail) {
    return (
      <div className="mx-auto max-w-3xl px-6 py-8">
        <Breadcrumb />
        <p className="mt-4 text-sm text-white/40">Loading call…</p>
      </div>
    );
  }

  const activity = detail.activity;
  const twilioStatus = activity?.status ?? "unknown";
  const isActive = !TERMINAL_STATUSES.has(twilioStatus);
  const liveSeconds = computeLiveSeconds(activity, now);
  const calleeLabel = formatCallee(detail.callee);

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-6 px-6 py-6">
      <Breadcrumb />

      <header className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="flex items-center gap-3">
            <h1 className="text-xl font-semibold text-white">{calleeLabel}</h1>
            <StatusPill status={twilioStatus} />
          </div>
          {detail.callee?.phone && (
            <p className="mt-1 font-mono text-sm text-white/60">
              {detail.callee.phone}
            </p>
          )}
        </div>
        <div className="flex flex-shrink-0 flex-col items-end gap-2">
          <button
            type="button"
            onClick={requestBackup}
            disabled={
              !isActive ||
              backupState.status === "requesting" ||
              backupState.status === "requested"
            }
            data-testid="request-backup"
            className="rounded-md bg-warn px-3 py-1.5 text-sm font-medium text-canvas hover:bg-warn/80 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {backupState.status === "requesting"
              ? "Requesting…"
              : backupState.status === "requested"
                ? backupState.existed
                  ? "Already pinged"
                  : "Backup requested"
                : "Request backup"}
          </button>
          {backupState.status === "error" && (
            <span className="text-xs text-bad">{backupState.message}</span>
          )}
        </div>
      </header>

      <div
        data-testid="live-duration"
        data-live-seconds={liveSeconds}
        className="rounded-lg border border-line bg-muted/40 p-5"
      >
        <div className="text-[10px] uppercase tracking-wide text-white/50">
          {isActive ? "Live duration" : "Call duration"}
        </div>
        <div className="mt-2 font-mono text-4xl text-white">
          {formatDuration(liveSeconds)}
        </div>
        {isActive && (
          <div
            data-testid="live-pulse"
            className="mt-1 inline-flex items-center gap-1.5 text-xs text-good"
          >
            <span className="h-2 w-2 animate-pulse rounded-full bg-good" />
            live
          </div>
        )}
      </div>

      <section className="rounded-lg border border-line bg-muted/20 p-4 text-sm">
        <h2 className="text-xs uppercase tracking-wide text-white/50">
          Call metadata
        </h2>
        <dl className="mt-3 grid grid-cols-1 gap-2 md:grid-cols-2">
          <MetaRow label="Workflow" value={detail.workflowId} mono />
          <MetaRow label="Call SID" value={activity?.callSid ?? "—"} mono />
          <MetaRow
            label="Workflow status"
            value={detail.workflow?.status ?? "—"}
          />
          <MetaRow
            label="Approval decision"
            value={detail.approval.decision}
          />
          {activity?.startedAt && (
            <MetaRow
              label="Started"
              value={new Date(activity.startedAt).toLocaleString()}
            />
          )}
        </dl>
      </section>

      {backupState.status === "requested" && (
        <section className="rounded-lg border border-warn/40 bg-warn/10 p-4 text-sm text-warn">
          Backup request created. See it in the{" "}
          <Link href="/app/approvals" className="underline">
            approvals inbox
          </Link>
          .{" "}
          {backupState.existed
            ? "An earlier request for this call is still open — the inbox shows one row, not two."
            : "Any reviewer with access can pick it up."}
        </section>
      )}

      {activity?.transcriptRef && (
        <Link
          href={`/app/calls/${params.id}/transcript`}
          className="text-sm text-accent hover:underline"
        >
          View transcript →
        </Link>
      )}
    </div>
  );
}

function Breadcrumb() {
  return (
    <nav className="text-xs text-white/40">
      <Link href="/app/calls" className="hover:text-white/80">
        Calls
      </Link>{" "}
      / <span className="text-white/60">Detail</span>
    </nav>
  );
}

function MetaRow({
  label,
  value,
  mono,
}: {
  label: string;
  value: string;
  mono?: boolean;
}) {
  return (
    <div className="flex items-baseline gap-2">
      <dt className="w-36 flex-shrink-0 text-xs text-white/40">{label}</dt>
      <dd className={`text-sm text-white/80 ${mono ? "font-mono" : ""}`}>
        {value}
      </dd>
    </div>
  );
}

function StatusPill({ status }: { status: string }) {
  const palette: Record<string, string> = {
    "in-progress": "bg-good/20 text-good",
    ringing: "bg-warn/20 text-warn",
    initiated: "bg-warn/20 text-warn",
    completed: "bg-muted/60 text-white/60",
    failed: "bg-bad/20 text-bad",
    busy: "bg-bad/20 text-bad",
    "no-answer": "bg-bad/20 text-bad",
    canceled: "bg-muted/60 text-white/60",
  };
  return (
    <span
      className={`inline-block rounded px-1.5 py-0.5 text-xs ${
        palette[status] ?? "bg-muted/60 text-white/70"
      }`}
    >
      {status}
    </span>
  );
}

/**
 * Live-duration math. For an active call with a null durationSeconds,
 * use (now - startedAt). For a terminal call the server has populated
 * durationSeconds; use that so the displayed value matches the audit
 * record exactly. When neither is available, show "—".
 */
function computeLiveSeconds(
  activity: CallDetail["activity"],
  nowMs: number,
): number | null {
  if (!activity) return null;
  if (typeof activity.durationSeconds === "number" && activity.durationSeconds >= 0) {
    return activity.durationSeconds;
  }
  const startedMs = new Date(activity.startedAt).getTime();
  if (!Number.isFinite(startedMs)) return null;
  return Math.max(0, Math.floor((nowMs - startedMs) / 1000));
}

function formatDuration(seconds: number | null): string {
  if (seconds === null) return "—";
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  const pad = (n: number): string => n.toString().padStart(2, "0");
  if (h > 0) return `${h}:${pad(m)}:${pad(s)}`;
  return `${pad(m)}:${pad(s)}`;
}

function formatCallee(callee: CallDetail["callee"]): string {
  if (!callee) return "Unknown contact";
  return callee.fullName ?? callee.phone ?? callee.id;
}
