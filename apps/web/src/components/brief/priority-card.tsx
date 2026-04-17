"use client";

import { useRouter } from "next/navigation";
import Link from "next/link";
import type { KeyboardEvent, MouseEvent } from "react";
import type { BriefPriority } from "@vex/domain";

/**
 * One priority card on the home screen. The whole card is a clickable
 * region (role=button, keyboard-actionable) that navigates to the
 * chat surface with a pre-filled ?ask= query param for deal and
 * organization priorities. The explicit action button in the bottom-
 * right (Review when the priority carries an approvalId, Ask Vex
 * otherwise) is a nested Link that stopPropagates so its navigation
 * target wins over the card-level navigation.
 *
 * The chat page reading the ?ask= param and auto-sending is a
 * separate change set; shipping the URL shape now keeps the link
 * target stable across that refactor.
 */

export interface PriorityCardProps {
  priority: BriefPriority;
  onAction?: () => void;
}

// Card tint + left-edge bar per urgency. Background tint is kept
// subtle so a list of high-urgency cards doesn't overwhelm the eye.
const URGENCY_CARD: Record<BriefPriority["urgency"], string> = {
  high: "border-red-500/50 bg-red-500/5 hover:bg-red-500/10",
  medium: "border-amber-500/50 bg-amber-500/5 hover:bg-amber-500/10",
  low: "border-line bg-muted/40 hover:bg-muted/60",
};

const URGENCY_BAR: Record<BriefPriority["urgency"], string> = {
  high: "bg-red-500",
  medium: "bg-amber-500",
  low: "bg-white/20",
};

// Object-chip dot colour mirrors the ContextChip conventions in the
// app shell so the visual mapping deal=teal, org=blue, contact=purple
// is consistent across surfaces.
const OBJECT_DOT: Record<BriefPriority["objectType"], string> = {
  deal: "bg-teal-400",
  organization: "bg-blue-400",
  contact: "bg-purple-400",
  approval: "bg-amber-400",
  campaign: "bg-emerald-400",
};

function cardHref(priority: BriefPriority): string | null {
  // Deals + organizations have a natural "show me X" chat prompt; the
  // other object types don't get whole-card navigation.
  if (priority.objectType === "deal") {
    const ref = priority.objectRef ?? priority.objectId;
    return `/app/chat?ask=${encodeURIComponent(`Show me deal ${ref}`)}`;
  }
  if (priority.objectType === "organization") {
    return `/app/chat?ask=${encodeURIComponent(`Show me ${priority.title}`)}`;
  }
  return null;
}

function actionHref(priority: BriefPriority): string | null {
  if (priority.approvalId) return "/app/approvals";
  if (priority.suggestedAction) {
    return `/app/chat?ask=${encodeURIComponent(`Help me with: ${priority.title}`)}`;
  }
  return null;
}

export function PriorityCard({ priority, onAction }: PriorityCardProps) {
  const router = useRouter();
  const cardTarget = cardHref(priority);
  const actionTarget = actionHref(priority);
  const actionLabel = priority.approvalId ? "Review" : "Ask Vex";
  const cardTint = URGENCY_CARD[priority.urgency];
  const barClass = URGENCY_BAR[priority.urgency];
  const dotClass = OBJECT_DOT[priority.objectType];

  const go = (): void => {
    if (cardTarget) router.push(cardTarget);
  };

  const onCardClick = (_e: MouseEvent<HTMLElement>): void => {
    go();
  };
  const onCardKey = (e: KeyboardEvent<HTMLElement>): void => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      go();
    }
  };
  const interactive = cardTarget !== null;

  return (
    <article
      data-card="priority"
      data-urgency={priority.urgency}
      {...(interactive
        ? {
            role: "button",
            tabIndex: 0,
            onClick: onCardClick,
            onKeyDown: onCardKey,
          }
        : {})}
      className={`relative rounded-lg border p-4 transition ${cardTint} ${
        interactive
          ? "cursor-pointer focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-white/40"
          : ""
      }`}
    >
      <div
        aria-hidden="true"
        className={`absolute left-0 top-0 h-full w-1 rounded-l-lg ${barClass}`}
      />
      <div className="pl-2">
        <h3 className="font-medium text-white">{priority.title}</h3>
        <p className="mt-1 text-sm text-white/60">{priority.reason}</p>
        <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
          <span className="inline-flex items-center gap-2 rounded-full border border-line bg-canvas/40 px-2 py-0.5 text-xs text-white/70">
            <span
              aria-hidden="true"
              className={`h-1.5 w-1.5 rounded-full ${dotClass}`}
            />
            {priority.objectRef ?? priority.objectType}
          </span>
          {actionTarget ? (
            <Link
              href={actionTarget}
              onClick={(e) => {
                e.stopPropagation();
                onAction?.();
              }}
              className="rounded-md border border-line bg-muted/40 px-3 py-1 text-xs text-white/80 transition hover:border-white/30 hover:text-white"
            >
              {actionLabel}
            </Link>
          ) : null}
        </div>
      </div>
    </article>
  );
}
