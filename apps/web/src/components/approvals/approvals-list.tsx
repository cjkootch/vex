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
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }

  async function decide(id: string, action: "approve" | "reject"): Promise<void> {
    const target = items.find((i) => i.id === id);
    if (!target) return;
    setItems((prev) => prev.filter((i) => i.id !== id));
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
        <header className="mb-3 flex items-baseline justify-between">
          <h2 className="text-base font-semibold">Pending</h2>
          <span className="text-xs text-white/40">{items.length} item{items.length === 1 ? "" : "s"}</span>
        </header>
        {loading ? (
          <p className="text-sm text-white/50">Loading…</p>
        ) : items.length === 0 ? (
          <p className="text-sm text-white/50">Nothing to review.</p>
        ) : (
          <ul className="space-y-3" data-testid="approvals-pending">
            {items.map((item) => (
              <ApprovalCard key={item.id} item={item} onDecide={decide} />
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
  onDecide,
}: {
  item: ApprovalRow;
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
