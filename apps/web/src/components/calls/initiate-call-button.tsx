"use client";

import { useRef, useState } from "react";
import Link from "next/link";

export interface InitiateCallButtonProps {
  contactId: string;
  contactName?: string;
  /** Optional callback fired after the workflow is queued. */
  onStarted?: (result: {
    workflowId: string;
    approvalId: string;
  }) => void;
  /** Short label variant — for table-row usage. */
  compact?: boolean;
}

type State =
  | { kind: "idle" }
  | { kind: "confirming" }
  | { kind: "starting" }
  | {
      kind: "started";
      workflowId: string;
      approvalId: string;
    }
  | { kind: "error"; message: string };

/**
 * Two-click outbound-call initiation. First click expands the button
 * into a Confirm / Cancel pair so we never dial without a deliberate
 * second click. POST /api/calls; surfaces 403 when T3 isn't enabled
 * for the workspace, 400 when the contact has no phone on file.
 *
 * Safe to mount anywhere contact context exists — /app/contacts/:id,
 * the deal war-room, or the calls page for ad-hoc dialing.
 */
export function InitiateCallButton({
  contactId,
  contactName,
  onStarted,
  compact,
}: InitiateCallButtonProps) {
  const [state, setState] = useState<State>({ kind: "idle" });
  const cancelRef = useRef<number | null>(null);

  const reset = (): void => {
    if (cancelRef.current !== null) window.clearTimeout(cancelRef.current);
    setState({ kind: "idle" });
  };

  const startConfirm = (): void => {
    setState({ kind: "confirming" });
    // Auto-cancel confirmation after 10 seconds so the button can't
    // linger in an armed state forever on a forgotten tab.
    cancelRef.current = window.setTimeout(() => reset(), 10_000);
  };

  const confirm = async (): Promise<void> => {
    if (cancelRef.current !== null) window.clearTimeout(cancelRef.current);
    setState({ kind: "starting" });
    try {
      const res = await fetch("/api/calls", {
        method: "POST",
        headers: { "content-type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ contact_id: contactId }),
      });
      if (res.status === 403) {
        const body = (await safeJson(res)) as { message?: string };
        setState({
          kind: "error",
          message:
            body?.message ??
            "Outbound calls aren't enabled for this workspace yet.",
        });
        return;
      }
      if (!res.ok) {
        const body = (await safeJson(res)) as { message?: string };
        setState({
          kind: "error",
          message: body?.message ?? `HTTP ${res.status}`,
        });
        return;
      }
      const data = (await res.json()) as {
        workflow_id?: string;
        approval_id?: string;
      };
      if (!data.workflow_id || !data.approval_id) {
        setState({
          kind: "error",
          message: "Missing workflow / approval id in response",
        });
        return;
      }
      setState({
        kind: "started",
        workflowId: data.workflow_id,
        approvalId: data.approval_id,
      });
      onStarted?.({
        workflowId: data.workflow_id,
        approvalId: data.approval_id,
      });
    } catch (err) {
      setState({ kind: "error", message: (err as Error).message });
    }
  };

  const targetLabel = contactName ?? "this contact";

  if (state.kind === "idle") {
    return (
      <button
        type="button"
        onClick={startConfirm}
        className={`inline-flex items-center gap-2 rounded-md border border-teal-400/50 bg-teal-500/10 ${compact ? "px-2.5 py-1 text-xs" : "px-3 py-1.5 text-sm"} text-teal-200 transition hover:bg-teal-500/20 hover:text-teal-100`}
      >
        <PhoneIcon />
        Initiate call
      </button>
    );
  }

  if (state.kind === "confirming") {
    return (
      <span className="inline-flex items-center gap-2">
        <span
          className={`${compact ? "text-xs" : "text-sm"} text-white/70`}
        >
          Call {targetLabel}?
        </span>
        <button
          type="button"
          onClick={confirm}
          className={`rounded-md bg-teal-500 ${compact ? "px-2.5 py-1 text-xs" : "px-3 py-1.5 text-sm"} text-white hover:bg-teal-400`}
        >
          Confirm
        </button>
        <button
          type="button"
          onClick={reset}
          className={`rounded-md border border-line bg-transparent ${compact ? "px-2.5 py-1 text-xs" : "px-3 py-1.5 text-sm"} text-white/70 hover:bg-white/5`}
        >
          Cancel
        </button>
      </span>
    );
  }

  if (state.kind === "starting") {
    return (
      <span
        aria-busy="true"
        className={`inline-flex items-center gap-2 ${compact ? "text-xs" : "text-sm"} text-white/60`}
      >
        <PhoneIcon />
        Starting call…
      </span>
    );
  }

  if (state.kind === "started") {
    return (
      <span
        className={`inline-flex items-center gap-3 ${compact ? "text-xs" : "text-sm"}`}
      >
        <span className="rounded-full border border-amber-500/50 bg-amber-500/10 px-2 py-0.5 text-amber-200">
          Pending approval
        </span>
        <Link
          href="/app/approvals"
          className="text-white/70 hover:text-white"
        >
          Review →
        </Link>
        <button
          type="button"
          onClick={reset}
          className="text-white/40 hover:text-white/70"
        >
          Dismiss
        </button>
      </span>
    );
  }

  // error
  return (
    <span
      className={`inline-flex items-center gap-2 ${compact ? "text-xs" : "text-sm"} text-red-300`}
    >
      <span>Call blocked: {state.message}</span>
      <button
        type="button"
        onClick={reset}
        className="text-white/40 hover:text-white/70"
      >
        Dismiss
      </button>
    </span>
  );
}

async function safeJson(res: Response): Promise<unknown> {
  try {
    return await res.json();
  } catch {
    return null;
  }
}

function PhoneIcon() {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.75}
      strokeLinecap="round"
      strokeLinejoin="round"
      className="h-3.5 w-3.5 flex-shrink-0"
      aria-hidden="true"
    >
      <path d="M22 16.92v3a2 2 0 01-2.18 2 19.79 19.79 0 01-8.63-3.07 19.5 19.5 0 01-6-6A19.79 19.79 0 012.12 4.18 2 2 0 014.11 2h3a2 2 0 012 1.72c.13.96.37 1.9.72 2.81a2 2 0 01-.45 2.11L8.09 9.91a16 16 0 006 6l1.27-1.27a2 2 0 012.11-.45c.91.35 1.85.59 2.81.72A2 2 0 0122 16.92z" />
    </svg>
  );
}
