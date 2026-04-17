"use client";

import { useState, type FormEvent } from "react";
import { Modal } from "@/components/ui/modal";
import { FormField, Select, TextArea } from "@/components/ui/form-field";

export const DEAL_STATUS_LABELS: Record<string, string> = {
  draft: "Draft",
  negotiating: "Negotiating",
  approved: "Approved",
  in_transit: "In Transit",
  delivered: "Delivered",
  settled: "Settled",
  cancelled: "Cancelled",
};

/**
 * Transitions that require a T2 approval instead of applying
 * immediately. Mirrors APPROVAL_REQUIRED_STATUSES in the API.
 */
export const APPROVAL_REQUIRED_STATUSES = new Set(["approved", "cancelled"]);

export interface DealStatusMenuProps {
  dealId: string;
  dealRef: string;
  currentStatus: string;
  /** Called after a direct transition applied; row should refetch. */
  onChanged: () => void;
  /** Called after an approval is requested; toast + link to /app/approvals. */
  onApprovalRequested: (approvalId: string) => void;
}

/**
 * Inline status menu for a deal row. Renders as a small dropdown of
 * all statuses; picking a "safe" one fires PATCH immediately, picking
 * a gated one (approved / cancelled) opens a rationale modal and
 * POSTs to the approval-request endpoint.
 */
export function DealStatusMenu({
  dealId,
  dealRef,
  currentStatus,
  onChanged,
  onApprovalRequested,
}: DealStatusMenuProps) {
  const [submitting, setSubmitting] = useState(false);
  const [requestFor, setRequestFor] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function applyDirect(next: string): Promise<void> {
    if (next === currentStatus) return;
    if (APPROVAL_REQUIRED_STATUSES.has(next)) {
      setRequestFor(next);
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch(`/api/deals/${dealId}/status`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ status: next }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { message?: string };
        throw new Error(body.message ?? `${res.status} ${res.statusText}`);
      }
      onChanged();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <>
      <Select
        value={currentStatus}
        disabled={submitting}
        onClick={(e) => e.stopPropagation()}
        onChange={(e) => {
          e.stopPropagation();
          void applyDirect(e.target.value);
        }}
        options={Object.entries(DEAL_STATUS_LABELS).map(([value, label]) => ({
          value,
          label: APPROVAL_REQUIRED_STATUSES.has(value)
            ? `${label} (approval)`
            : label,
        }))}
      />
      {error && (
        <div className="mt-1 text-xs text-bad">{error}</div>
      )}
      {requestFor && (
        <ApprovalRequestModal
          dealId={dealId}
          dealRef={dealRef}
          targetStatus={requestFor}
          onClose={() => setRequestFor(null)}
          onRequested={(approvalId) => {
            setRequestFor(null);
            onApprovalRequested(approvalId);
          }}
        />
      )}
    </>
  );
}

function ApprovalRequestModal({
  dealId,
  dealRef,
  targetStatus,
  onClose,
  onRequested,
}: {
  dealId: string;
  dealRef: string;
  targetStatus: string;
  onClose: () => void;
  onRequested: (approvalId: string) => void;
}) {
  const [rationale, setRationale] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(e: FormEvent<HTMLFormElement>): Promise<void> {
    e.preventDefault();
    if (submitting) return;
    if (rationale.trim().length < 5) {
      setError("Give a short rationale (5+ characters) so the reviewer has context.");
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch(`/api/deals/${dealId}/status/request`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          status: targetStatus,
          rationale: rationale.trim(),
        }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { message?: string };
        throw new Error(body.message ?? `${res.status} ${res.statusText}`);
      }
      const body = (await res.json()) as { approvalId: string };
      onRequested(body.approvalId);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Modal
      open
      onClose={() => (submitting ? undefined : onClose())}
      title={`Request ${DEAL_STATUS_LABELS[targetStatus] ?? targetStatus} on ${dealRef}`}
      description="Approval required — a reviewer will see your rationale and decide."
    >
      <form onSubmit={onSubmit} className="flex flex-col gap-3">
        <FormField
          label="Rationale"
          required
          hint="What changed? Why is this deal ready for the new status?"
        >
          <TextArea
            value={rationale}
            onChange={(e) => setRationale(e.target.value)}
            placeholder="OFAC clearance received; LC draft signed by both parties…"
            maxLength={1000}
            autoFocus
          />
        </FormField>

        {error && (
          <div className="rounded-md border border-bad/40 bg-bad/10 px-3 py-2 text-sm text-bad">
            {error}
          </div>
        )}

        <div className="mt-2 flex justify-end gap-2 border-t border-line pt-4">
          <button
            type="button"
            onClick={onClose}
            disabled={submitting}
            className="rounded-md border border-line px-3 py-1.5 text-sm text-white/80 hover:border-accent hover:text-white disabled:opacity-40"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={submitting}
            className="rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-white hover:bg-accent/90 disabled:opacity-40"
          >
            {submitting ? "Requesting…" : "Request approval"}
          </button>
        </div>
      </form>
    </Modal>
  );
}
