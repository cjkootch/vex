"use client";

import { useEffect, useState } from "react";

interface ContactOption {
  id: string;
  fullName: string;
  emails?: string[];
}

interface MergeResult {
  touchpoints: number;
  memberships: number;
  deals: number;
  leads: number;
  enrollments: number;
}

/**
 * Merge dialog for the contact detail page. Operator picks a target
 * contact; we call POST /contacts/:sourceId/merge-into. The source is
 * soft-archived (opt_out_reason = merged_into:<target>) and every FK
 * repoints to the target. Destructive — requires a typed confirmation.
 */
export function MergeContactDialog({
  open,
  source,
  onClose,
  onMerged,
}: {
  open: boolean;
  source: { id: string; fullName: string };
  onClose: () => void;
  onMerged: (targetId: string, result: MergeResult) => void;
}): React.ReactElement | null {
  const [options, setOptions] = useState<ContactOption[]>([]);
  const [targetId, setTargetId] = useState<string>("");
  const [confirm, setConfirm] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    fetch("/api/contacts?limit=500")
      .then((res) => (res.ok ? res.json() : Promise.reject(res.status)))
      .then((body: { contacts?: ContactOption[] }) => {
        if (cancelled || !Array.isArray(body.contacts)) return;
        setOptions(body.contacts.filter((c) => c.id !== source.id));
      })
      .catch(() => setOptions([]));
    return () => {
      cancelled = true;
    };
  }, [open, source.id]);

  if (!open) return null;

  const canMerge =
    targetId.length > 0 &&
    confirm.trim().toLowerCase() === source.fullName.trim().toLowerCase();

  async function merge(): Promise<void> {
    setPending(true);
    setError(null);
    try {
      const res = await fetch(`/api/contacts/${source.id}/merge-into`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ targetId }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as {
          message?: string;
        };
        throw new Error(body.message ?? `${res.status}`);
      }
      const body = (await res.json()) as { moved: MergeResult };
      onMerged(targetId, body.moved);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setPending(false);
    }
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      className="fixed inset-0 z-40 flex items-center justify-center bg-black/60 px-4"
    >
      <div className="w-full max-w-lg rounded-lg border border-line bg-canvas p-5">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h2 className="text-lg font-semibold text-white">Merge contact</h2>
            <p className="mt-1 text-xs text-white/60">
              Merging <span className="text-white">{source.fullName}</span> into
              another contact repoints touchpoints, memberships, deals, leads,
              and campaign enrollments to the target. Emails + phones are
              unioned. The source is archived and flagged as opted-out with
              reason <span className="font-mono">merged_into:…</span>.
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="text-xs text-white/50 hover:text-white"
          >
            Close
          </button>
        </div>

        <label className="mt-4 flex flex-col gap-1">
          <span className="text-[11px] uppercase tracking-wide text-white/50">
            Target contact
          </span>
          <select
            value={targetId}
            onChange={(e) => setTargetId(e.target.value)}
            className="rounded-md border border-line bg-canvas px-3 py-2 text-sm text-white focus:border-accent focus:outline-none"
          >
            <option value="">Select a target…</option>
            {options.map((c) => (
              <option key={c.id} value={c.id}>
                {c.fullName}
                {c.emails && c.emails[0] ? ` (${c.emails[0]})` : ""}
              </option>
            ))}
          </select>
        </label>

        <label className="mt-3 flex flex-col gap-1">
          <span className="text-[11px] uppercase tracking-wide text-white/50">
            Type <span className="font-mono text-white/80">{source.fullName}</span>{" "}
            to confirm
          </span>
          <input
            type="text"
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            className="rounded-md border border-line bg-canvas px-3 py-2 font-mono text-sm text-white focus:border-accent focus:outline-none"
            autoComplete="off"
          />
        </label>

        {error && (
          <div className="mt-3 rounded-md border border-bad/40 bg-bad/10 px-3 py-2 text-xs text-bad">
            {error}
          </div>
        )}

        <div className="mt-5 flex items-center justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="rounded-md border border-line px-3 py-1.5 text-sm text-white/80 hover:border-white/60"
          >
            Cancel
          </button>
          <button
            type="button"
            disabled={!canMerge || pending}
            onClick={() => void merge()}
            className="rounded-md bg-bad px-3 py-1.5 text-sm font-medium text-white hover:bg-bad/80 disabled:opacity-40"
          >
            {pending ? "Merging…" : "Merge"}
          </button>
        </div>
      </div>
    </div>
  );
}
