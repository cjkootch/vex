"use client";

import { formatVexCopy } from "@vex/ui";

/**
 * Persistent orientation anchor shown at the top of every workspace
 * view. Answers the implicit "what is Vex talking about right now?"
 * question so the user can switch attention between deals, companies,
 * contacts, and modes without losing context.
 *
 * Renders as a pill in the Vex muted-panel style. The coloured dot on
 * the left is driven by `type` in the default (active) state and by
 * `status` when the chip is surfacing a warning or critical condition.
 */

export type ContextChipType =
  | "deal"
  | "organization"
  | "contact"
  | "mode"
  | "none";

export type ContextChipStatus = "active" | "warning" | "critical";

export interface ContextChipProps {
  type: ContextChipType;
  /** Primary label — deal ref, company name, contact name, or mode title. */
  label: string;
  /** Optional secondary line shown in muted smaller text after a middle dot. */
  sublabel?: string;
  /** When provided, an X button is rendered on the right. Fires on click. */
  onClear?: () => void;
  /** Drives the dot colour + border when non-active. Defaults to "active". */
  status?: ContextChipStatus;
}

// Type → dot colour in the "active" state. Each type gets a distinct hue
// so a glance identifies the subject without reading the label.
const TYPE_DOT: Record<ContextChipType, string> = {
  deal: "bg-teal-400",
  organization: "bg-blue-400",
  contact: "bg-purple-400",
  mode: "bg-amber-400",
  none: "bg-white/20",
};

// Status overrides the dot colour when warning / critical. `active`
// returns null so the type colour comes through unchanged.
const STATUS_DOT: Record<ContextChipStatus, string | null> = {
  active: null,
  warning: "bg-amber-400",
  critical: "bg-red-500",
};

// Status drives the border. Default chip uses the same line colour as
// other muted panels; warning / critical tint the border to match.
const STATUS_BORDER: Record<ContextChipStatus, string> = {
  active: "border-line",
  warning: "border-amber-500/60",
  critical: "border-red-500/60",
};

export function ContextChip({
  type,
  label,
  sublabel,
  onClear,
  status = "active",
}: ContextChipProps) {
  const dotClass = STATUS_DOT[status] ?? TYPE_DOT[type];
  const borderClass = STATUS_BORDER[status];
  // Subtle opacity pulse on the dot only — the whole chip pulsing would
  // be distracting. `animate-pulse` is Tailwind's stock utility.
  const dotPulse = status === "critical" ? "animate-pulse" : "";

  return (
    <div
      data-chip="context"
      data-type={type}
      data-status={status}
      className={`inline-flex items-center gap-2 rounded-full border ${borderClass} bg-muted/40 px-3 py-1.5 text-sm`}
    >
      <span
        aria-hidden="true"
        className={`h-2 w-2 rounded-full ${dotClass} ${dotPulse}`}
      />
      <span className="font-medium text-white">{label}</span>
      {sublabel ? (
        <span className="hidden text-xs text-white/60 sm:inline">
          <span aria-hidden="true" className="mx-1">
            ·
          </span>
          {sublabel}
        </span>
      ) : null}
      {onClear ? (
        <button
          type="button"
          onClick={onClear}
          aria-label={formatVexCopy("Clear {label}", { label })}
          className="ml-1 rounded-full p-0.5 text-white/40 transition-colors hover:bg-white/10 hover:text-white/80 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-white/40"
        >
          <svg
            xmlns="http://www.w3.org/2000/svg"
            viewBox="0 0 20 20"
            fill="currentColor"
            aria-hidden="true"
            className="h-3.5 w-3.5"
          >
            <path
              fillRule="evenodd"
              d="M4.293 4.293a1 1 0 011.414 0L10 8.586l4.293-4.293a1 1 0 111.414 1.414L11.414 10l4.293 4.293a1 1 0 01-1.414 1.414L10 11.414l-4.293 4.293a1 1 0 01-1.414-1.414L8.586 10 4.293 5.707a1 1 0 010-1.414z"
              clipRule="evenodd"
            />
          </svg>
        </button>
      ) : null}
    </div>
  );
}
