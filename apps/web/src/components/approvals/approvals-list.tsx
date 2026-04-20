"use client";

import { useEffect, useState } from "react";

/** Tiny relative-time formatter so this file stays dep-free. */
function relativeTime(date: Date): string {
  const ms = Date.now() - date.getTime();
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

export interface ApprovalRow {
  id: string;
  actionType: string;
  decision: "pending" | "approved" | "rejected" | "auto_approved";
  createdAt: string;
  decidedAt?: string | null;
  proposedPayload: Record<string, unknown>;
}

export function ApprovalsList() {
  const [items, setItems] = useState<ApprovalRow[]>([]);
  const [decided, setDecided] = useState<ApprovalRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [bulkRunning, setBulkRunning] = useState(false);

  useEffect(() => {
    void load();
  }, []);

  async function load(): Promise<void> {
    setLoading(true);
    try {
      const r = await fetch("/api/approvals?status=pending");
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const json = (await r.json()) as { approvals: ApprovalRow[] };
      setItems(json.approvals);
      setSelected(new Set());
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }

  function toggle(id: string): void {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function toggleAll(): void {
    setSelected((prev) =>
      prev.size === items.length ? new Set() : new Set(items.map((i) => i.id)),
    );
  }

  async function decide(id: string, action: "approve" | "reject"): Promise<void> {
    const target = items.find((i) => i.id === id);
    if (!target) return;
    setItems((prev) => prev.filter((i) => i.id !== id));
    setSelected((prev) => {
      if (!prev.has(id)) return prev;
      const next = new Set(prev);
      next.delete(id);
      return next;
    });
    try {
      const r = await fetch(`/api/approvals/${encodeURIComponent(id)}/${action}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const json = (await r.json()) as { approval: ApprovalRow };
      setDecided((prev) => [{ ...target, ...json.approval }, ...prev]);
    } catch (err) {
      // Revert on failure so the row is reviewable again.
      setItems((prev) => [target, ...prev]);
      setError((err as Error).message);
    }
  }

  async function bulkDecide(action: "approve" | "reject"): Promise<void> {
    const ids = Array.from(selected);
    if (ids.length === 0) return;
    const targets = items.filter((i) => selected.has(i.id));
    setBulkRunning(true);
    setItems((prev) => prev.filter((i) => !selected.has(i.id)));
    try {
      const r = await fetch(`/api/approvals/bulk-decide`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ids, decision: action }),
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const json = (await r.json()) as {
        decided: Array<Pick<ApprovalRow, "id" | "decision" | "decidedAt">>;
        skipped: string[];
      };
      const decidedIds = new Set(json.decided.map((d) => d.id));
      // Promote decided rows into the "decided this session" pane.
      setDecided((prev) => [
        ...targets
          .filter((t) => decidedIds.has(t.id))
          .map((t) => ({
            ...t,
            decision:
              action === "approve"
                ? ("approved" as const)
                : ("rejected" as const),
            decidedAt: new Date().toISOString(),
          })),
        ...prev,
      ]);
      // Anything the server skipped (already decided, not found) — surface
      // it briefly so the operator knows not every row moved.
      if (json.skipped.length > 0) {
        setError(`${json.skipped.length} already handled — refreshing.`);
        void load();
      } else {
        setSelected(new Set());
      }
    } catch (err) {
      // Revert — bulk failure is rare enough that restoring the full
      // selection beats trying to reconcile a partial response.
      setItems((prev) => [...targets, ...prev]);
      setError((err as Error).message);
    } finally {
      setBulkRunning(false);
    }
  }

  return (
    <div className="space-y-8">
      {error && (
        <p
          data-testid="approvals-error"
          className="rounded-md bg-bad/10 px-3 py-2 text-sm text-bad"
        >
          {error}
        </p>
      )}

      <section>
        <header className="mb-3 flex items-baseline justify-between gap-4">
          <h2 className="text-base font-semibold">Pending</h2>
          <div className="flex items-center gap-3 text-xs text-white/40">
            {items.length > 0 && (
              <label className="flex items-center gap-1.5 text-white/60">
                <input
                  type="checkbox"
                  data-testid="approvals-select-all"
                  checked={selected.size === items.length && items.length > 0}
                  onChange={toggleAll}
                  className="h-3.5 w-3.5 rounded border-line bg-canvas"
                />
                Select all
              </label>
            )}
            <span>
              {items.length} item{items.length === 1 ? "" : "s"}
            </span>
          </div>
        </header>
        {selected.size > 0 && (
          <div
            data-testid="approvals-bulk-bar"
            className="mb-3 flex items-center justify-between rounded-md border border-accent/40 bg-accent/10 px-3 py-2 text-sm"
          >
            <span className="text-white/80">
              {selected.size} selected
            </span>
            <div className="flex gap-2">
              <button
                type="button"
                data-testid="bulk-approve"
                onClick={() => bulkDecide("approve")}
                disabled={bulkRunning}
                className="rounded-md bg-good px-3 py-1 text-xs font-medium text-canvas disabled:opacity-50"
              >
                {bulkRunning ? "Approving…" : `Approve ${selected.size}`}
              </button>
              <button
                type="button"
                data-testid="bulk-reject"
                onClick={() => bulkDecide("reject")}
                disabled={bulkRunning}
                className="rounded-md border border-line px-3 py-1 text-xs text-white/70 hover:bg-white/5 disabled:opacity-50"
              >
                Reject {selected.size}
              </button>
            </div>
          </div>
        )}
        {loading ? (
          <p className="text-sm text-white/50">Loading…</p>
        ) : items.length === 0 ? (
          <p className="text-sm text-white/50">Nothing to review.</p>
        ) : (
          <ul className="space-y-3" data-testid="approvals-pending">
            {items.map((item) => (
              <ApprovalCard
                key={item.id}
                item={item}
                selected={selected.has(item.id)}
                onToggle={toggle}
                onDecide={decide}
              />
            ))}
          </ul>
        )}
      </section>

      <section>
        <header className="mb-3 flex items-baseline justify-between">
          <h2 className="text-base font-semibold">Decided this session</h2>
          <span className="text-xs text-white/40">{decided.length}</span>
        </header>
        <ul className="space-y-2" data-testid="approvals-decided">
          {decided.map((item) => (
            <li
              key={item.id}
              className="rounded border border-line/60 bg-canvas/40 px-3 py-2 text-xs text-white/60"
            >
              <span className="rounded bg-white/10 px-1.5 py-0.5 font-mono">{item.actionType}</span>{" "}
              <span
                className={`ml-2 rounded px-1.5 py-0.5 ${
                  item.decision === "approved"
                    ? "bg-good/20 text-good"
                    : "bg-bad/20 text-bad"
                }`}
              >
                {item.decision}
              </span>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}

function ApprovalCard({
  item,
  selected,
  onToggle,
  onDecide,
}: {
  item: ApprovalRow;
  selected: boolean;
  onToggle: (id: string) => void;
  onDecide: (id: string, action: "approve" | "reject") => void | Promise<void>;
}) {
  const tier = stringField(item.proposedPayload, "tier") ?? "T?";
  const created = new Date(item.createdAt);

  // Per-actionType body renderer. Defaults to the Sprint-6 suggestion
  // shape (subject / opening) so existing follow_up.suggestion rows
  // keep working. New campaign.enroll_batch shape from Sprint F gets
  // a dedicated summary panel — plan steps + recipient count beat
  // raw JSON for reviewer comprehension.
  let body: JSX.Element;
  if (item.actionType === "campaign.enroll_batch") {
    body = <EnrollBatchBody payload={item.proposedPayload} />;
  } else if (item.actionType === "call.request_backup") {
    body = <CallBackupBody payload={item.proposedPayload} />;
  } else {
    const subject =
      stringField(item.proposedPayload, "subject_line") ?? "(no subject)";
    const opening = stringField(item.proposedPayload, "opening_line") ?? "";
    const subjectId = stringField(item.proposedPayload, "subject_id");
    body = (
      <>
        <div className="mt-2 text-sm font-semibold text-white">{subject}</div>
        {opening && <p className="text-sm text-white/70">{opening}</p>}
        {subjectId && (
          <p className="mt-1 text-xs text-white/40">subject: {subjectId}</p>
        )}
      </>
    );
  }

  return (
    <li
      data-testid="approval-row"
      className="rounded-lg border border-line bg-muted/40 p-4"
    >
      <header className="mb-2 flex items-start justify-between gap-3">
        <input
          type="checkbox"
          data-testid="approval-select"
          checked={selected}
          onChange={() => onToggle(item.id)}
          className="mt-1 h-4 w-4 rounded border-line bg-canvas"
          aria-label={`Select approval ${item.id}`}
        />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 text-xs text-white/50">
            <span className="rounded bg-white/10 px-1.5 py-0.5 font-mono">{item.actionType}</span>
            <span className="rounded bg-warn/20 px-1.5 py-0.5 text-warn">{tier}</span>
            <span title={created.toISOString()}>
              {relativeTime(created)}
            </span>
          </div>
          {body}
        </div>
        <div className="flex flex-none gap-2">
          <button
            type="button"
            onClick={() => onDecide(item.id, "approve")}
            data-testid="approve"
            className="rounded-md bg-good px-3 py-1.5 text-sm font-medium text-canvas"
          >
            Approve
          </button>
          <button
            type="button"
            onClick={() => onDecide(item.id, "reject")}
            data-testid="reject"
            className="rounded-md border border-line px-3 py-1.5 text-sm text-white/70 hover:bg-white/5"
          >
            Reject
          </button>
        </div>
      </header>
    </li>
  );
}

interface PlanStepSummary {
  position: number;
  channel: string;
  tier: string;
  auto_approve: boolean;
  delay_after_prior_ms?: number;
}

/**
 * Sprint F — renders campaign.enroll_batch payloads. The reviewer
 * needs the recipient count + the plan shape (channels, delays,
 * which steps auto-approve) at a glance — raw JSON hides all of it.
 */
function EnrollBatchBody({
  payload,
}: {
  payload: Record<string, unknown>;
}) {
  const campaignId = stringField(payload, "campaign_id");
  const recipientCount = numberField(payload, "recipient_count") ?? 0;
  const planSummary = Array.isArray(payload["plan_summary"])
    ? (payload["plan_summary"] as unknown[]).filter(isPlanStepSummary)
    : [];
  const rationale = stringField(payload, "rationale");

  return (
    <div className="mt-2 space-y-2">
      <div
        data-testid="enroll-batch-heading"
        className="flex items-baseline gap-2 text-sm font-semibold text-white"
      >
        <span>Enroll</span>
        <span className="rounded bg-accent/20 px-1.5 py-0.5 font-mono text-accent">
          {recipientCount} contact{recipientCount === 1 ? "" : "s"}
        </span>
        {campaignId && (
          <span className="truncate font-mono text-xs text-white/50">
            · campaign {campaignId.slice(0, 12)}…
          </span>
        )}
      </div>
      {planSummary.length > 0 ? (
        <ol className="flex flex-col gap-1 border-l-2 border-line/60 pl-3">
          {planSummary.map((s) => (
            <li
              key={s.position}
              data-testid="enroll-batch-step"
              className="flex items-baseline gap-2 text-xs"
            >
              <span className="font-mono text-accent">#{s.position}</span>
              <span className="text-white/80">{s.channel}</span>
              <span className="rounded bg-muted/60 px-1 py-0.5 font-mono text-[10px] text-white/60">
                {s.tier}
              </span>
              {s.auto_approve && (
                <span className="rounded bg-good/20 px-1 py-0.5 text-[10px] text-good">
                  auto-approve
                </span>
              )}
              {typeof s.delay_after_prior_ms === "number" && s.delay_after_prior_ms > 0 && (
                <span className="text-white/40">
                  wait {formatDelay(s.delay_after_prior_ms)}
                </span>
              )}
            </li>
          ))}
        </ol>
      ) : (
        <p className="text-xs text-white/40">plan summary unavailable</p>
      )}
      {rationale && (
        <p className="border-t border-line/40 pt-2 text-xs italic text-white/60">
          “{rationale}”
        </p>
      )}
    </div>
  );
}

/**
 * Sprint I — renders call.request_backup payloads. The operator needs
 * to see: which call is pinging, how long the agent has been on it,
 * optional reason, and a "Join call" CTA that deep-links to the call
 * detail page. (Actual join / live-listen lands in Sprint J once the
 * OutboundCallWorkflow is restructured on a Twilio Conference.)
 */
function CallBackupBody({
  payload,
}: {
  payload: Record<string, unknown>;
}) {
  const workflowId = stringField(payload, "workflow_id");
  const durationAtRequest = numberField(payload, "duration_at_request_seconds");
  const callSid = stringField(payload, "call_sid");
  const reason = stringField(payload, "reason");
  return (
    <div className="mt-2 space-y-2">
      <div
        data-testid="call-backup-heading"
        className="flex items-baseline gap-2 text-sm font-semibold text-white"
      >
        <span>Agent needs a human</span>
        {typeof durationAtRequest === "number" && (
          <span className="rounded bg-warn/20 px-1.5 py-0.5 font-mono text-warn">
            {formatDurationShort(durationAtRequest)} on call
          </span>
        )}
      </div>
      <dl className="flex flex-wrap gap-x-4 gap-y-0.5 text-xs text-white/60">
        {workflowId && (
          <div>
            <dt className="inline text-white/40">workflow </dt>
            <dd className="inline font-mono text-white/70">
              {workflowId.slice(0, 20)}…
            </dd>
          </div>
        )}
        {callSid && (
          <div>
            <dt className="inline text-white/40">sid </dt>
            <dd className="inline font-mono text-white/70">
              {callSid.slice(0, 12)}…
            </dd>
          </div>
        )}
      </dl>
      {reason && (
        <p className="border-t border-line/40 pt-2 text-xs italic text-white/60">
          “{reason}”
        </p>
      )}
      {workflowId && (
        <a
          href={`/app/calls/${encodeURIComponent(workflowId)}`}
          data-testid="call-backup-join"
          className="inline-flex items-center gap-1 rounded-md bg-accent px-2.5 py-1 text-xs font-medium text-white hover:bg-accent/80"
        >
          Join call →
        </a>
      )}
    </div>
  );
}

function formatDurationShort(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}m${s > 0 ? ` ${s}s` : ""}`;
}

function isPlanStepSummary(value: unknown): value is PlanStepSummary {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v["position"] === "number" &&
    typeof v["channel"] === "string" &&
    typeof v["tier"] === "string" &&
    typeof v["auto_approve"] === "boolean"
  );
}

function formatDelay(ms: number): string {
  if (ms <= 0) return "immediately";
  const hours = ms / 3600_000;
  if (hours < 1) return `${Math.round(ms / 60_000)}m`;
  if (hours < 48) return `${hours.toFixed(1)}h`;
  const days = hours / 24;
  return `${days.toFixed(0)}d`;
}

function numberField(payload: Record<string, unknown>, key: string): number | null {
  const v = payload[key];
  return typeof v === "number" ? v : null;
}

function stringField(payload: Record<string, unknown>, key: string): string | null {
  const v = payload[key];
  return typeof v === "string" ? v : null;
}
