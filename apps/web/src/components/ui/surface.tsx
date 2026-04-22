import type { ElementType, ReactNode } from "react";

/**
 * Named surfaces. Every card in Vex now reaches for one of these
 * instead of bespoke `border border-line bg-muted/20` strings. The
 * goal is that an operator develops visual literacy: "violet-tinted
 * card = Vex generated this; amber border = this is at risk;
 * neutral raised card = static record."
 *
 *   raised   default card sitting on the canvas — records, forms,
 *            timelines, data tables
 *   quiet    low-contrast row container, for lists of items that
 *            should feel grouped but not framed
 *   intel    AI-generated / AI-operated content (Ask Vex menus,
 *            agent suggestions, brief priorities written by Vex)
 *   warn     needs-attention states (stale, incomplete, pending)
 *   blocker  hard stop states (OFAC match, declined counterparty,
 *            approval rejected)
 */

export type SurfaceTone = "raised" | "quiet" | "intel" | "warn" | "blocker";

export interface SurfaceProps {
  tone?: SurfaceTone;
  as?: ElementType;
  className?: string;
  children: ReactNode;
}

const TONE_CLASSES: Record<SurfaceTone, string> = {
  raised:
    "rounded-lg border border-line bg-surface-1 shadow-soft",
  quiet: "rounded-lg border border-line-soft bg-surface-1/60",
  intel:
    "rounded-lg surface-intel shadow-intel-glow",
  warn:
    "rounded-lg border border-warn/45 bg-warn/[0.06]",
  blocker:
    "rounded-lg border border-bad/50 bg-bad/[0.06]",
};

export function Surface({
  tone = "raised",
  as: As = "section",
  className,
  children,
}: SurfaceProps): React.ReactElement {
  return (
    <As className={`${TONE_CLASSES[tone]}${className ? ` ${className}` : ""}`}>
      {children}
    </As>
  );
}

/**
 * "Vex ran this" signature badge. Sits on an intel surface to make
 * the provenance legible at a glance. Restrained: one dot, tight
 * label, no decoration beyond the violet accent.
 */
export function IntelBadge({
  label = "Vex",
  className,
}: {
  label?: string;
  className?: string;
}): React.ReactElement {
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full bg-intel-soft/80 px-2 py-0.5 text-[10px] font-semibold tracking-wider2 text-accent-strong ${className ?? ""}`}
    >
      <span
        aria-hidden="true"
        className="h-1.5 w-1.5 rounded-full bg-accent shadow-[0_0_6px_rgba(124,92,255,0.7)]"
      />
      {label.toUpperCase()}
    </span>
  );
}

/**
 * Status dot — one pixel ratio, one sizing rule, consistent tones
 * across the product. Replaces the half-dozen hand-rolled dot
 * spans scattered through cards today.
 */
export type DotTone =
  | "good"
  | "warn"
  | "bad"
  | "intel"
  | "neutral"
  | "pulse-intel";

const DOT_CLASSES: Record<DotTone, string> = {
  good: "bg-emerald-400",
  warn: "bg-amber-400",
  bad: "bg-red-500",
  intel: "bg-accent shadow-[0_0_6px_rgba(124,92,255,0.7)]",
  neutral: "bg-text-muted/60",
  "pulse-intel": "bg-accent animate-pulse",
};

export function StatusDot({
  tone = "neutral",
  className,
}: {
  tone?: DotTone;
  className?: string;
}): React.ReactElement {
  return (
    <span
      aria-hidden="true"
      className={`inline-block h-1.5 w-1.5 flex-shrink-0 rounded-full ${DOT_CLASSES[tone]} ${className ?? ""}`}
    />
  );
}
