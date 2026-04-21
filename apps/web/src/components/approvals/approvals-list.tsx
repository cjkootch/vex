"use client";

import { useEffect, useState } from "react";
import Link from "next/link";

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
            <DecidedRow key={item.id} item={item} />
          ))}
        </ul>
      </section>
    </div>
  );
}

/**
 * Row in the "Decided this session" list. Fires a single-shot
 * outcome fetch 2s after mount (gives the approval-executor worker
 * a moment to pick the BullMQ job up), then polls every 10s for up
 * to a minute. Stops as soon as status is no longer "queued".
 *
 * Surfaces the real answer the operator wants: did the side effect
 * actually land, or did the executor bounce (e.g. "missing toNumber"
 * on an outbound_call where Claude didn't pull a real phone)?
 */
interface ExecutorOutcome {
  status: "queued" | "applied" | "failed" | "skipped";
  reason: string | null;
  actionType: string | null;
  appliedObjectId: string | null;
  appliedAt: string | null;
  occurredAt: string | null;
}

function DecidedRow({ item }: { item: ApprovalRow }) {
  const [outcome, setOutcome] = useState<ExecutorOutcome | null>(null);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    if (item.decision !== "approved" && item.decision !== "auto_approved") {
      // Rejected approvals never go to the executor; nothing to poll.
      return;
    }
    let cancelled = false;
    let attempts = 0;
    const MAX = 7; // 2s + 6×10s = ~62s total
    const fetchOnce = async (): Promise<void> => {
      attempts += 1;
      try {
        const r = await fetch(
          `/api/approvals/${encodeURIComponent(item.id)}/outcome`,
          { cache: "no-store" },
        );
        if (!r.ok) return;
        const body = (await r.json()) as { outcome: ExecutorOutcome | null };
        if (cancelled) return;
        setLoaded(true);
        if (body.outcome) setOutcome(body.outcome);
        if (!body.outcome || body.outcome.status === "queued") {
          if (attempts < MAX) setTimeout(() => void fetchOnce(), 10_000);
        }
      } catch {
        /* silent — caller sees the last status we had */
      }
    };
    const t = setTimeout(() => void fetchOnce(), 2_000);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [item.id, item.decision]);

  const statusTone =
    outcome?.status === "applied"
      ? "bg-good/20 text-good"
      : outcome?.status === "failed"
        ? "bg-bad/20 text-bad"
        : outcome?.status === "skipped"
          ? "bg-white/10 text-white/70"
          : item.decision === "approved" || item.decision === "auto_approved"
            ? "bg-good/20 text-good"
            : "bg-bad/20 text-bad";
  const statusLabel =
    outcome?.status === "applied"
      ? "applied"
      : outcome?.status === "failed"
        ? "executor failed"
        : outcome?.status === "skipped"
          ? "already applied"
          : item.decision === "approved" && loaded
            ? "queued"
            : item.decision;

  return (
    <li
      data-testid="approval-decided-row"
      className="space-y-1 rounded border border-line/60 bg-canvas/40 px-3 py-2 text-xs text-white/60"
    >
      <div className="flex flex-wrap items-center gap-2">
        <span className="rounded bg-white/10 px-1.5 py-0.5 font-mono">
          {item.actionType}
        </span>
        <span className={`rounded px-1.5 py-0.5 ${statusTone}`}>
          {statusLabel}
        </span>
        {outcome?.status === "queued" && item.decision === "approved" ? (
          <span className="text-[11px] italic text-white/40">
            executor hasn&rsquo;t run yet…
          </span>
        ) : null}
      </div>
      {outcome?.status === "failed" && outcome.reason ? (
        <p className="text-[11px] leading-relaxed text-bad">
          ⚠ {outcome.reason}
        </p>
      ) : null}
    </li>
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

  // Per-actionType body renderer. Each action that ships through chat
  // or an autonomous agent has its own renderer so the operator sees
  // the actual fields they're approving — not "(no subject)" + opaque
  // ULIDs. The generic GenericPayloadBody at the bottom catches new
  // action kinds we haven't built a dedicated renderer for yet.
  let body: JSX.Element;
  switch (item.actionType) {
    case "campaign.enroll_batch":
      body = <EnrollBatchBody payload={item.proposedPayload} />;
      break;
    case "contact.merge":
      body = <ContactMergeBody payload={item.proposedPayload} />;
      break;
    case "contact.update":
      body = <ContactUpdateBody payload={item.proposedPayload} />;
      break;
    case "call.request_backup":
      body = <CallBackupBody payload={item.proposedPayload} />;
      break;
    case "outbound_call":
      body = <OutboundCallBody payload={item.proposedPayload} />;
      break;
    case "email.send":
      body = <EmailSendBody payload={item.proposedPayload} />;
      break;
    case "crm.create_deal":
      body = <CreateDealBody payload={item.proposedPayload} />;
      break;
    case "crm.create_contact":
      body = <CreateContactBody payload={item.proposedPayload} />;
      break;
    case "crm.create_company":
      body = <CreateCompanyBody payload={item.proposedPayload} />;
      break;
    case "campaign.create":
      body = <CreateCampaignBody payload={item.proposedPayload} />;
      break;
    case "sms.send":
    case "whatsapp.send":
      body = <MessageSendBody payload={item.proposedPayload} kind={item.actionType} />;
      break;
    case "follow_up.suggestion":
      // Original Sprint-6 shape — subject_line + opening_line + subject_id.
      body = <FollowUpSuggestionBody payload={item.proposedPayload} />;
      break;
    default:
      body = <GenericPayloadBody payload={item.proposedPayload} />;
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

/**
 * outbound_call payload renderer. The user is approving a real PSTN
 * dial — they need to see exactly what number, who's getting called,
 * whether it's AI-driven or operator-joined, and any custom AI
 * instructions.
 */
function OutboundCallBody({
  payload,
}: {
  payload: Record<string, unknown>;
}) {
  const toNumber =
    stringField(payload, "toNumber") ?? stringField(payload, "to_number");
  const contactId =
    stringField(payload, "contactId") ?? stringField(payload, "contact_id");
  const orgId = stringField(payload, "orgId") ?? stringField(payload, "org_id");
  const aiMode =
    payload["aiMode"] === true || payload["ai_mode"] === true;
  const aiInstructions =
    stringField(payload, "aiInstructions") ??
    stringField(payload, "ai_instructions");
  const rationale = stringField(payload, "rationale");
  const missing: string[] = [];
  if (!toNumber) missing.push("toNumber");
  if (!contactId) missing.push("contactId");
  if (!orgId) missing.push("orgId");
  return (
    <div className="mt-2 space-y-1.5">
      <div className="flex items-center gap-2 text-sm">
        <span className="font-semibold text-white">
          {aiMode ? "Vex calls" : "Dial out"}
        </span>
        <span className="font-mono text-white">{toNumber ?? "<no phone>"}</span>
        {aiMode ? (
          <span className="rounded bg-accent/20 px-1.5 py-0.5 text-[10px] text-accent">
            AI-driven
          </span>
        ) : (
          <span className="rounded bg-white/10 px-1.5 py-0.5 text-[10px] text-white/60">
            operator joins
          </span>
        )}
      </div>
      {(contactId || orgId) && (
        <div className="flex flex-wrap gap-3 text-[11px] text-white/50">
          {contactId && (
            <div>
              <span className="opacity-60">contact </span>
              <Link
                href={`/app/contacts/${encodeURIComponent(contactId)}`}
                className="font-mono text-white/70 hover:text-accent"
              >
                {contactId.slice(-8)}
              </Link>
            </div>
          )}
          {orgId && (
            <div>
              <span className="opacity-60">org </span>
              <Link
                href={`/app/companies/${encodeURIComponent(orgId)}`}
                className="font-mono text-white/70 hover:text-accent"
              >
                {orgId.slice(-8)}
              </Link>
            </div>
          )}
        </div>
      )}
      {aiInstructions && (
        <div className="rounded border border-accent/30 bg-accent/5 p-2 text-xs">
          <div className="mb-1 text-[10px] uppercase tracking-wider text-accent/70">
            AI instructions
          </div>
          <p className="whitespace-pre-wrap text-white/80">{aiInstructions}</p>
        </div>
      )}
      {rationale && (
        <p className="border-t border-line/40 pt-1.5 text-xs italic text-white/60">
          “{rationale}”
        </p>
      )}
      {missing.length > 0 && (
        <p className="text-xs text-bad">
          ⚠ Missing required field{missing.length === 1 ? "" : "s"}:{" "}
          {missing.join(", ")}. Approving this will fail at the executor.
        </p>
      )}
    </div>
  );
}

/**
 * email.send payload renderer. The reviewer needs to see who, what
 * subject, and a preview of the body — not just "(no subject)".
 */
function EmailSendBody({ payload }: { payload: Record<string, unknown> }) {
  const subject = stringField(payload, "subject");
  const body = stringField(payload, "body");
  const tos = Array.isArray(payload["to"])
    ? (payload["to"] as unknown[]).filter((v): v is string => typeof v === "string")
    : [];
  const supplier = stringField(payload, "supplier_org_id");
  const leadId = stringField(payload, "lead_id");
  const drafted = stringField(payload, "auto_drafted_from");
  const rationale = stringField(payload, "rationale");
  return (
    <div className="mt-2 space-y-1.5">
      <div className="flex items-baseline gap-2">
        <span className="text-[10px] uppercase tracking-wider text-white/40">to</span>
        <span className="font-mono text-sm text-white">
          {tos.length > 0 ? tos.join(", ") : "<no recipient>"}
        </span>
      </div>
      <div className="text-sm font-semibold text-white">
        {subject ?? "(no subject)"}
      </div>
      {body && (
        <div className="rounded border border-line/40 bg-canvas/40 p-2 text-xs leading-relaxed text-white/80">
          <div className="line-clamp-6 whitespace-pre-wrap">{body}</div>
        </div>
      )}
      {(drafted || supplier || leadId) && (
        <div className="flex flex-wrap gap-3 text-[10px] text-white/50">
          {drafted && (
            <span>
              <span className="opacity-60">via </span>
              <span className="font-mono">{drafted}</span>
            </span>
          )}
          {supplier && (
            <span>
              <span className="opacity-60">supplier </span>
              <Link
                href={`/app/companies/${encodeURIComponent(supplier)}`}
                className="font-mono hover:text-accent"
              >
                {supplier.slice(-8)}
              </Link>
            </span>
          )}
          {leadId && (
            <span>
              <span className="opacity-60">lead </span>
              <span className="font-mono">{leadId.slice(-8)}</span>
            </span>
          )}
        </div>
      )}
      {rationale && (
        <p className="border-t border-line/40 pt-1.5 text-xs italic text-white/60">
          “{rationale}”
        </p>
      )}
    </div>
  );
}

/**
 * sms.send / whatsapp.send — single line, single body. Same payload
 * shape per the action descriptor (to E.164 + body).
 */
function MessageSendBody({
  payload,
  kind,
}: {
  payload: Record<string, unknown>;
  kind: "sms.send" | "whatsapp.send";
}) {
  const to = stringField(payload, "to");
  const body = stringField(payload, "body");
  const rationale = stringField(payload, "rationale");
  const channel = kind === "sms.send" ? "SMS" : "WhatsApp";
  return (
    <div className="mt-2 space-y-1.5">
      <div className="flex items-baseline gap-2 text-sm">
        <span className="text-white/60">{channel} →</span>
        <span className="font-mono text-white">{to ?? "<no number>"}</span>
      </div>
      {body && (
        <div className="rounded border border-line/40 bg-canvas/40 p-2 text-sm text-white/85">
          <p className="whitespace-pre-wrap">{body}</p>
        </div>
      )}
      {rationale && (
        <p className="border-t border-line/40 pt-1.5 text-xs italic text-white/60">
          “{rationale}”
        </p>
      )}
    </div>
  );
}

/**
 * crm.create_deal payload renderer. Surfaces the deal's identity +
 * commercial terms so the reviewer can sanity-check defaults
 * (incoterm, paymentTerms, pricingBasis) before the row lands.
 */
function CreateDealBody({ payload }: { payload: Record<string, unknown> }) {
  const dealRef = stringField(payload, "dealRef");
  const product = stringField(payload, "product");
  const lineOfBusiness = stringField(payload, "lineOfBusiness");
  const volume = numberField(payload, "volumeUsg");
  const volumeUnit = stringField(payload, "volumeUnit");
  const buyerOrgId = stringField(payload, "buyerOrgId");
  const destination = stringField(payload, "destinationPort");
  const incoterm = stringField(payload, "incoterm");
  const pricingBasis = stringField(payload, "pricingBasis");
  const paymentTerms = stringField(payload, "paymentTerms");
  const notes = stringField(payload, "notes");
  const rationale = stringField(payload, "rationale");
  return (
    <div className="mt-2 space-y-2">
      <div className="flex flex-wrap items-baseline gap-2 text-sm">
        <span className="font-mono font-semibold text-white">{dealRef ?? "<no ref>"}</span>
        <span className="text-white">{product ?? "<no product>"}</span>
        {lineOfBusiness && (
          <span className="rounded bg-white/10 px-1.5 py-0.5 text-[10px] uppercase text-white/60">
            {lineOfBusiness}
          </span>
        )}
      </div>
      <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs sm:grid-cols-3">
        {typeof volume === "number" && (
          <KV label="Volume">
            {volume.toLocaleString()} {(volumeUnit ?? "").toUpperCase()}
          </KV>
        )}
        {destination && <KV label="Destination">{destination}</KV>}
        {incoterm && <KV label="Incoterm">{incoterm.toUpperCase()}</KV>}
        {pricingBasis && <KV label="Pricing">{pricingBasis}</KV>}
        {paymentTerms && <KV label="Payment">{paymentTerms.toUpperCase()}</KV>}
        {buyerOrgId && (
          <KV label="Buyer">
            <Link
              href={`/app/companies/${encodeURIComponent(buyerOrgId)}`}
              className="font-mono hover:text-accent"
            >
              {buyerOrgId.slice(-8)}
            </Link>
          </KV>
        )}
      </dl>
      {notes && (
        <p className="rounded border border-line/40 bg-canvas/40 p-2 text-xs text-white/70">
          {notes}
        </p>
      )}
      {rationale && (
        <p className="border-t border-line/40 pt-1.5 text-xs italic text-white/60">
          “{rationale}”
        </p>
      )}
    </div>
  );
}

function ContactUpdateBody({ payload }: { payload: Record<string, unknown> }) {
  const contactId = stringField(payload, "contactId");
  const patch = (payload["patch"] ?? {}) as Record<string, unknown>;
  const rationale = stringField(payload, "rationale");
  const rows: Array<{ label: string; value: string }> = [];
  const push = (label: string, val: unknown): void => {
    if (val === undefined) return;
    if (val === null) {
      rows.push({ label, value: "<cleared>" });
      return;
    }
    if (Array.isArray(val)) {
      rows.push({ label, value: val.length === 0 ? "<empty>" : val.join(", ") });
      return;
    }
    if (typeof val === "string") rows.push({ label, value: val });
  };
  push("Name", patch["fullName"]);
  push("Title", patch["title"]);
  push("Emails", patch["emails"]);
  push("Phones", patch["phones"]);
  push("Timezone", patch["timezone"]);
  push("Tags", patch["tags"]);

  return (
    <div className="mt-2 space-y-1.5">
      <div className="flex items-center gap-2 text-sm">
        <span className="font-semibold text-white">Update contact</span>
        {contactId ? (
          <Link
            href={`/app/contacts/${encodeURIComponent(contactId)}`}
            className="font-mono text-white/70 hover:text-accent"
          >
            {contactId.slice(-8)}
          </Link>
        ) : (
          <span className="text-bad">&lt;no contactId&gt;</span>
        )}
      </div>
      {rows.length > 0 ? (
        <dl className="grid grid-cols-[80px_1fr] gap-x-4 gap-y-1 text-xs">
          {rows.map((r) => (
            <KV key={r.label} label={r.label}>{r.value}</KV>
          ))}
        </dl>
      ) : (
        <p className="text-xs text-bad">⚠ patch is empty — executor will reject.</p>
      )}
      <p className="text-[11px] text-white/40">
        Arrays REPLACE the existing set (emails / phones / tags), not
        append. Verify the full target list above before approving.
      </p>
      {rationale && (
        <p className="border-t border-line/40 pt-1.5 text-xs italic text-white/60">
          “{rationale}”
        </p>
      )}
    </div>
  );
}

function ContactMergeBody({ payload }: { payload: Record<string, unknown> }) {
  const sourceId = stringField(payload, "sourceContactId");
  const targetId = stringField(payload, "targetContactId");
  const rationale = stringField(payload, "rationale");
  const missing: string[] = [];
  if (!sourceId) missing.push("sourceContactId");
  if (!targetId) missing.push("targetContactId");
  return (
    <div className="mt-2 space-y-1.5">
      <div className="flex items-center gap-2 text-sm text-white">
        <span className="font-semibold">Merge</span>
        {sourceId ? (
          <Link
            href={`/app/contacts/${encodeURIComponent(sourceId)}`}
            className="font-mono text-white/70 hover:text-accent"
          >
            {sourceId.slice(-8)}
          </Link>
        ) : (
          <span className="text-bad">&lt;no source&gt;</span>
        )}
        <span className="text-white/50">→</span>
        {targetId ? (
          <Link
            href={`/app/contacts/${encodeURIComponent(targetId)}`}
            className="font-mono text-white hover:text-accent"
          >
            {targetId.slice(-8)}
          </Link>
        ) : (
          <span className="text-bad">&lt;no target&gt;</span>
        )}
      </div>
      <p className="text-[11px] text-white/50">
        Target keeps the record + inherits source&rsquo;s touchpoints,
        activities, leads, org memberships, emails, phones, tags. Source
        is archived with a tombstone pointer (reversible later).
      </p>
      {rationale && (
        <p className="border-t border-line/40 pt-1.5 text-xs italic text-white/60">
          “{rationale}”
        </p>
      )}
      {missing.length > 0 && (
        <p className="text-xs text-bad">
          ⚠ Missing required field{missing.length === 1 ? "" : "s"}:{" "}
          {missing.join(", ")}. Approving this will fail at the executor.
        </p>
      )}
    </div>
  );
}

function CreateContactBody({ payload }: { payload: Record<string, unknown> }) {
  const name = stringField(payload, "name");
  const email = stringField(payload, "email");
  const phone = stringField(payload, "phone");
  const title = stringField(payload, "title");
  const orgId = stringField(payload, "organizationId") ?? stringField(payload, "orgId");
  const rationale = stringField(payload, "rationale");
  return (
    <div className="mt-2 space-y-1.5">
      <div className="text-sm font-semibold text-white">{name ?? "<no name>"}</div>
      <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs">
        {title && <KV label="Title">{title}</KV>}
        {email && <KV label="Email">{email}</KV>}
        {phone && <KV label="Phone">{phone}</KV>}
        {orgId && (
          <KV label="Org">
            <Link
              href={`/app/companies/${encodeURIComponent(orgId)}`}
              className="font-mono hover:text-accent"
            >
              {orgId.slice(-8)}
            </Link>
          </KV>
        )}
      </dl>
      {rationale && (
        <p className="border-t border-line/40 pt-1.5 text-xs italic text-white/60">
          “{rationale}”
        </p>
      )}
    </div>
  );
}

function CreateCompanyBody({ payload }: { payload: Record<string, unknown> }) {
  const name = stringField(payload, "legalName") ?? stringField(payload, "name");
  const domain = stringField(payload, "domain");
  const industry = stringField(payload, "industry");
  const rationale = stringField(payload, "rationale");
  return (
    <div className="mt-2 space-y-1.5">
      <div className="text-sm font-semibold text-white">{name ?? "<no name>"}</div>
      <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs">
        {domain && <KV label="Domain">{domain}</KV>}
        {industry && <KV label="Industry">{industry}</KV>}
      </dl>
      {rationale && (
        <p className="border-t border-line/40 pt-1.5 text-xs italic text-white/60">
          “{rationale}”
        </p>
      )}
    </div>
  );
}

function CreateCampaignBody({ payload }: { payload: Record<string, unknown> }) {
  const name = stringField(payload, "name");
  const channel = stringField(payload, "channel");
  const objective = stringField(payload, "objective");
  const steps = Array.isArray(payload["steps"]) ? (payload["steps"] as unknown[]) : [];
  const rationale = stringField(payload, "rationale");
  return (
    <div className="mt-2 space-y-2">
      <div className="flex items-baseline gap-2 text-sm">
        <span className="font-semibold text-white">{name ?? "<no name>"}</span>
        {channel && (
          <span className="rounded bg-white/10 px-1.5 py-0.5 text-[10px] uppercase text-white/60">
            {channel}
          </span>
        )}
        <span className="text-xs text-white/50">{steps.length} step{steps.length === 1 ? "" : "s"}</span>
      </div>
      {objective && <p className="text-xs text-white/70">{objective}</p>}
      {steps.length > 0 && (
        <ol className="flex flex-col gap-0.5 border-l-2 border-line/60 pl-3">
          {steps.map((s, i) => {
            if (typeof s !== "object" || s === null) return null;
            const obj = s as Record<string, unknown>;
            const ch = stringField(obj, "channel") ?? "?";
            const tier = stringField(obj, "tier") ?? "?";
            const delay = numberField(obj, "delayAfterPriorMs");
            return (
              <li key={i} className="flex items-baseline gap-2 text-[11px] text-white/70">
                <span className="font-mono text-accent">#{i}</span>
                <span>{ch}</span>
                <span className="rounded bg-muted/60 px-1 py-0.5 font-mono text-[10px] text-white/60">
                  {tier}
                </span>
                {typeof delay === "number" && delay > 0 && (
                  <span className="text-white/40">wait {formatDelay(delay)}</span>
                )}
              </li>
            );
          })}
        </ol>
      )}
      {rationale && (
        <p className="border-t border-line/40 pt-1.5 text-xs italic text-white/60">
          “{rationale}”
        </p>
      )}
    </div>
  );
}

function FollowUpSuggestionBody({ payload }: { payload: Record<string, unknown> }) {
  const subject = stringField(payload, "subject_line") ?? "(no subject)";
  const opening = stringField(payload, "opening_line") ?? "";
  const subjectId = stringField(payload, "subject_id");
  return (
    <>
      <div className="mt-2 text-sm font-semibold text-white">{subject}</div>
      {opening && <p className="text-sm text-white/70">{opening}</p>}
      {subjectId && (
        <p className="mt-1 text-xs text-white/40">subject: {subjectId}</p>
      )}
    </>
  );
}

/**
 * Final fallback when no per-type renderer matches. Renders payload
 * key/values minus internal noise (`tier`, `audit_event_id`,
 * `auto_drafted_from`, anything starting with `_`). Beats a blank
 * card or "(no subject)" for newly-introduced action types.
 */
const HIDDEN_PAYLOAD_KEYS = new Set([
  "tier",
  "audit_event_id",
  "auto_drafted_from",
  "rationale",
]);
function GenericPayloadBody({ payload }: { payload: Record<string, unknown> }) {
  const entries = Object.entries(payload).filter(
    ([k, v]) =>
      !HIDDEN_PAYLOAD_KEYS.has(k) &&
      !k.startsWith("_") &&
      v !== null &&
      v !== undefined &&
      v !== "",
  );
  const rationale = stringField(payload, "rationale");
  return (
    <div className="mt-2 space-y-1.5">
      {entries.length === 0 ? (
        <p className="text-xs text-white/40">No additional details on this proposal.</p>
      ) : (
        <dl className="grid grid-cols-1 gap-x-4 gap-y-1 text-xs sm:grid-cols-2">
          {entries.map(([k, v]) => (
            <KV key={k} label={k}>{renderPayloadValue(v)}</KV>
          ))}
        </dl>
      )}
      {rationale && (
        <p className="border-t border-line/40 pt-1.5 text-xs italic text-white/60">
          “{rationale}”
        </p>
      )}
    </div>
  );
}

function renderPayloadValue(v: unknown): string {
  if (v === null || v === undefined) return "—";
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  if (Array.isArray(v)) return v.length === 0 ? "[]" : `[${v.length} item${v.length === 1 ? "" : "s"}]`;
  if (typeof v === "object") return JSON.stringify(v).slice(0, 200);
  return String(v);
}

function KV({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col">
      <dt className="text-[10px] uppercase tracking-wider text-white/40">{label}</dt>
      <dd className="text-white/90">{children}</dd>
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
