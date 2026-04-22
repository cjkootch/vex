"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { formatDistanceToNow } from "date-fns";

/**
 * /app/calls/:id/debug — one-screen timeline of a call attempt.
 *
 * Consolidates every row the calling pipeline touches: approval,
 * agent run, voice_call activity, every audit event keyed off the
 * workflow id, and Temporal's live workflow status. Built after a
 * night of "my call didn't ring" debugging that required ten tool
 * calls to figure out it was the 9pm call-window gate rejecting it.
 */

interface CallDebug {
  workflowId: string;
  approval: {
    id: string;
    actionType: string;
    decision: string;
    createdAt: string;
    decidedAt: string | null;
    appliedAt: string | null;
    appliedObjectId: string | null;
    reviewerId: string | null;
    proposedPayload: Record<string, unknown>;
  } | null;
  agentRun: {
    id: string;
    agentName: string;
    status: string;
    startedAt: string;
    finishedAt: string | null;
    costUsd: number | null;
    error: string | null;
  } | null;
  activity: {
    id: string;
    type: string;
    callSid: string | null;
    status: string;
    durationSeconds: number | null;
    occurredAt: string;
  } | null;
  events: Array<{
    id: string;
    verb: string;
    actorType: string | null;
    actorId: string | null;
    occurredAt: string;
    metadata: Record<string, unknown>;
  }>;
  workflow: { status: string | null; reason: string | null } | null;
}

export default function CallDebugPage({
  params,
}: {
  params: { id: string };
}): React.ReactElement {
  const [data, setData] = useState<CallDebug | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setData(null);
    const load = () => {
      fetch(`/api/calls/${params.id}/debug`)
        .then(async (res) => {
          if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
          return res.json();
        })
        .then((body: CallDebug) => {
          if (!cancelled) {
            setData(body);
            setError(null);
          }
        })
        .catch((err: Error) => {
          if (!cancelled) setError(err.message);
        });
    };
    load();
    const interval = setInterval(load, 5_000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [params.id]);

  if (error) {
    return (
      <div className="mx-auto max-w-3xl px-6 py-8">
        <div className="rounded-md border border-bad/40 bg-bad/10 px-3 py-2 text-sm text-bad">
          {error}
        </div>
      </div>
    );
  }
  if (!data) {
    return (
      <div className="mx-auto max-w-3xl px-6 py-8 text-sm text-white/50">
        Loading…
      </div>
    );
  }

  const stages = buildStages(data);

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-4 px-6 py-8">
      <header>
        <Link
          href={`/app/calls/${params.id}`}
          className="text-xs text-white/50 hover:text-white/80"
        >
          ← Call
        </Link>
        <h1 className="mt-1 text-xl font-semibold text-white">
          Call debug timeline
        </h1>
        <p className="mt-1 font-mono text-xs text-white/40">
          {data.workflowId}
        </p>
      </header>

      <section className="grid grid-cols-1 gap-3 rounded-lg border border-line bg-muted/20 p-4 text-sm sm:grid-cols-3">
        <StatusCell
          label="Approval"
          value={data.approval?.decision ?? "—"}
          sub={
            data.approval
              ? data.approval.appliedAt
                ? `applied ${formatDistanceToNow(new Date(data.approval.appliedAt), { addSuffix: true })}`
                : data.approval.decidedAt
                  ? `decided, not applied`
                  : `created ${formatDistanceToNow(new Date(data.approval.createdAt), { addSuffix: true })}`
              : "no approval row"
          }
          tone={approvalTone(data.approval)}
        />
        <StatusCell
          label="Workflow"
          value={data.workflow?.status ?? "unknown"}
          sub={data.workflow?.reason ?? ""}
          tone={workflowTone(data.workflow?.status ?? null)}
        />
        <StatusCell
          label="Activity"
          value={data.activity?.status ?? "—"}
          sub={
            data.activity?.callSid
              ? data.activity.callSid
              : data.activity
                ? "no call SID yet"
                : "not yet created"
          }
          tone={activityTone(data.activity?.status ?? null)}
        />
      </section>

      {data.agentRun && (
        <section className="rounded-lg border border-line bg-muted/20 p-4 text-sm">
          <div className="mb-1 text-[11px] uppercase tracking-wide text-white/40">
            Agent run
          </div>
          <div className="flex items-center justify-between">
            <div>
              <span className="font-medium text-white">
                {data.agentRun.agentName}
              </span>
              <span className="ml-2 font-mono text-xs text-white/40">
                {data.agentRun.id.slice(-8)}
              </span>
            </div>
            <span
              className={`rounded px-1.5 py-0.5 text-xs ${agentRunTone(data.agentRun.status)}`}
            >
              {data.agentRun.status}
            </span>
          </div>
          {data.agentRun.error && (
            <div className="mt-2 rounded-md border border-bad/40 bg-bad/10 px-2 py-1 text-xs text-bad">
              {data.agentRun.error}
            </div>
          )}
        </section>
      )}

      <section>
        <h2 className="mb-2 text-[11px] uppercase tracking-wide text-white/40">
          Pipeline stages
        </h2>
        <ol className="flex flex-col rounded-lg border border-line bg-muted/10">
          {stages.map((s, i) => (
            <li
              key={i}
              className="border-b border-line/60 px-4 py-3 last:border-b-0"
            >
              <div className="flex items-center justify-between gap-3">
                <div className="flex items-center gap-2">
                  <span className="font-mono text-[11px] text-white/40">
                    {String(i + 1).padStart(2, "0")}
                  </span>
                  <span className="text-sm text-white/90">{s.label}</span>
                </div>
                <span className={`rounded px-1.5 py-0.5 text-xs ${stageTone(s.state)}`}>
                  {s.state}
                </span>
              </div>
              {s.detail && (
                <div className="mt-1 ml-8 text-xs text-white/50">
                  {s.detail}
                </div>
              )}
            </li>
          ))}
        </ol>
      </section>

      <section>
        <h2 className="mb-2 text-[11px] uppercase tracking-wide text-white/40">
          Audit events ({data.events.length})
        </h2>
        {data.events.length === 0 ? (
          <p className="rounded-md border border-line bg-muted/20 px-3 py-2 text-sm text-white/50">
            No audit events for this workflow yet.
          </p>
        ) : (
          <ol className="flex flex-col divide-y divide-line/60 rounded-lg border border-line bg-muted/10">
            {data.events.map((e) => (
              <li key={e.id} className="px-4 py-2 text-xs">
                <div className="flex items-baseline justify-between gap-3">
                  <span className="font-mono text-white/90">{e.verb}</span>
                  <span className="text-white/40">
                    {new Date(e.occurredAt).toLocaleTimeString()} ·{" "}
                    {formatDistanceToNow(new Date(e.occurredAt), {
                      addSuffix: true,
                    })}
                  </span>
                </div>
                {Object.keys(e.metadata).length > 0 && (
                  <pre className="mt-1 overflow-x-auto rounded bg-bg/60 p-2 text-[11px] text-white/60">
                    {JSON.stringify(e.metadata, null, 2)}
                  </pre>
                )}
              </li>
            ))}
          </ol>
        )}
      </section>

      {data.approval && (
        <section>
          <h2 className="mb-2 text-[11px] uppercase tracking-wide text-white/40">
            Proposed payload
          </h2>
          <pre className="overflow-x-auto rounded-lg border border-line bg-muted/10 p-4 text-[11px] text-white/70">
            {JSON.stringify(data.approval.proposedPayload, null, 2)}
          </pre>
        </section>
      )}
    </div>
  );
}

interface Stage {
  label: string;
  state: "done" | "pending" | "rejected" | "running" | "missing";
  detail?: string;
}

function buildStages(data: CallDebug): Stage[] {
  const stages: Stage[] = [];
  const eventsByVerb = new Map<string, CallDebug["events"][number]>();
  for (const e of data.events) eventsByVerb.set(e.verb, e);

  // 1. Approval created
  stages.push({
    label: "Approval created",
    state: data.approval ? "done" : "missing",
    detail: data.approval
      ? `${data.approval.actionType} — id ${data.approval.id.slice(-8)}`
      : "no approval row found for this workflow",
  });

  // 2. Approval decided
  stages.push({
    label: "Approval decided",
    state: data.approval?.decidedAt
      ? data.approval.decision === "rejected"
        ? "rejected"
        : "done"
      : data.approval
        ? "pending"
        : "missing",
    detail: data.approval
      ? `${data.approval.decision}${data.approval.reviewerId ? ` by ${data.approval.reviewerId}` : ""}`
      : "",
  });

  // 3. Executor picked up
  const executorFailed = data.events.find((e) =>
    e.verb.includes("executor.failed"),
  );
  stages.push({
    label: "Approval executor ran",
    state: executorFailed
      ? "rejected"
      : data.approval?.appliedAt
        ? "done"
        : data.approval?.decision === "approved" ||
            data.approval?.decision === "auto_approved"
          ? "pending"
          : "missing",
    detail: executorFailed
      ? JSON.stringify(executorFailed.metadata)
      : data.approval?.appliedAt
        ? `applied at ${new Date(data.approval.appliedAt).toLocaleTimeString()}`
        : "",
  });

  // 4. Workflow started
  const workflowStarted = data.events.find(
    (e) => e.verb === "call.initiated" || e.verb.includes("workflow.started"),
  );
  stages.push({
    label: "Workflow started",
    state: data.workflow
      ? data.workflow.status === "RUNNING"
        ? "running"
        : "done"
      : workflowStarted
        ? "done"
        : "missing",
    detail: data.workflow?.status ?? "",
  });

  // 5. Call window
  const windowRejected = eventsByVerb.get("call.rejected.outside_window");
  stages.push({
    label: "Call window check",
    state: windowRejected ? "rejected" : "done",
    detail: windowRejected
      ? String(windowRejected.metadata["reason"] ?? "outside window")
      : "skipped or allowed",
  });

  // 6. Suppression
  const suppressed = eventsByVerb.get("call.rejected.suppressed");
  stages.push({
    label: "Suppression check",
    state: suppressed ? "rejected" : "done",
    detail: suppressed
      ? String(suppressed.metadata["reason"] ?? "contact opted out")
      : "allowed",
  });

  // 7. Twilio dial
  stages.push({
    label: "Twilio dial",
    state: data.activity?.callSid
      ? "done"
      : data.workflow?.status === "RUNNING"
        ? "pending"
        : data.approval?.appliedAt
          ? "pending"
          : "missing",
    detail: data.activity?.callSid
      ? `SID ${data.activity.callSid} · status=${data.activity.status}`
      : "no call activity yet",
  });

  // 8. Call complete
  const completed = eventsByVerb.get("call.completed");
  stages.push({
    label: "Call complete",
    state: completed
      ? "done"
      : data.activity?.status === "completed"
        ? "done"
        : "pending",
    detail: data.activity?.durationSeconds
      ? `${data.activity.durationSeconds}s`
      : "",
  });

  return stages;
}

function StatusCell({
  label,
  value,
  sub,
  tone,
}: {
  label: string;
  value: string;
  sub: string;
  tone: string;
}) {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-[11px] uppercase tracking-wide text-white/40">
        {label}
      </span>
      <span className={`text-lg font-medium ${tone}`}>{value}</span>
      <span className="text-[11px] text-white/40">{sub}</span>
    </div>
  );
}

function approvalTone(a: CallDebug["approval"]): string {
  if (!a) return "text-white/40";
  if (a.decision === "rejected") return "text-bad";
  if (a.appliedAt) return "text-good";
  if (a.decidedAt) return "text-warn";
  return "text-white/80";
}

function workflowTone(s: string | null): string {
  if (!s) return "text-white/40";
  if (s === "RUNNING") return "text-accent";
  if (s === "COMPLETED") return "text-good";
  if (s === "FAILED" || s === "TERMINATED" || s === "TIMED_OUT") return "text-bad";
  return "text-white/80";
}

function activityTone(s: string | null): string {
  if (!s) return "text-white/40";
  if (s === "completed") return "text-good";
  if (s === "failed" || s === "no-answer" || s === "busy") return "text-bad";
  if (s === "in-progress") return "text-accent";
  return "text-white/80";
}

function agentRunTone(s: string): string {
  if (s === "failed") return "bg-bad/20 text-bad";
  if (s === "completed") return "bg-good/20 text-good";
  if (s === "running") return "bg-accent/20 text-accent";
  return "bg-muted/60 text-white/70";
}

function stageTone(state: Stage["state"]): string {
  switch (state) {
    case "done":
      return "bg-good/20 text-good";
    case "rejected":
      return "bg-bad/20 text-bad";
    case "running":
      return "bg-accent/20 text-accent";
    case "pending":
      return "bg-warn/20 text-warn";
    case "missing":
      return "bg-muted/60 text-white/50";
  }
}
