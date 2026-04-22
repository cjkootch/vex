"use client";

import Link from "next/link";
import type { BriefPriority } from "@vex/domain";
import { buildAskVexHref, type AskVexSubjectType } from "@/lib/ask-vex";

/**
 * One priority card on the home screen. Action-dense by design: the
 * operator should see at a glance what this priority *is* and pick
 * from two or three one-click next steps without another click-
 * through. The old behaviour (whole-card nav into chat) hijacked
 * clicks and hid the action set behind a single muted button.
 *
 * Action set per priority type:
 *
 *   approval priorities        → [Review, Ask Vex]
 *   deal / org / contact       → [View, Ask Vex] (+ Review if approvalId set)
 *   campaign / unknown         → [Ask Vex] only
 *
 * Primary button is accent-filled; secondaries get muted borders so the
 * scan reads left-to-right: reason → object → primary action.
 */

export interface PriorityCardProps {
  priority: BriefPriority;
  onAction?: () => void;
}

// Card tint + left-edge bar per urgency. Background tint is kept
// subtle so a list of high-urgency cards doesn't overwhelm the eye.
const URGENCY_CARD: Record<BriefPriority["urgency"], string> = {
  high: "border-red-500/50 bg-red-500/5",
  medium: "border-amber-500/50 bg-amber-500/5",
  low: "border-line bg-muted/40",
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

interface CardAction {
  label: string;
  href: string;
  primary?: boolean;
}

/**
 * Deep-link to the entity's detail page, when it has one. Approvals
 * route through the shared /app/approvals inbox; campaigns go to
 * /app/marketing/:id. Contact/deal/organization detail pages share
 * the /app/<type>s/:id convention.
 */
function detailHref(priority: BriefPriority): string | null {
  switch (priority.objectType) {
    case "deal":
      return `/app/deals/${priority.objectId}`;
    case "organization":
      return `/app/companies/${priority.objectId}`;
    case "contact":
      return `/app/contacts/${priority.objectId}`;
    case "campaign":
      return `/app/marketing/${priority.objectId}`;
    case "approval":
      return null;
  }
}

/**
 * Scope the "Ask Vex" link to the priority's subject when possible so
 * chat opens pre-filled with the right retrieval context. Approvals
 * and campaigns share a campaign/approval-review conversation pattern.
 */
function askVexHref(priority: BriefPriority): string {
  const suggested =
    priority.suggestedAction ??
    `Help me with: ${priority.title}. (${priority.reason})`;
  const subjectTypeMap: Record<BriefPriority["objectType"], AskVexSubjectType | null> = {
    deal: "deal",
    organization: "organization",
    contact: "contact",
    campaign: "campaign",
    approval: null,
  };
  const type = subjectTypeMap[priority.objectType];
  if (!type) {
    return `/app/chat?ask=${encodeURIComponent(suggested)}`;
  }
  return buildAskVexHref({
    type,
    id: priority.objectId,
    label: priority.objectRef ?? priority.title,
    ask: suggested,
  });
}

/**
 * Order matters — `actions[0]` renders as the primary button; the rest
 * are secondary. When nothing but "Ask Vex" is available (unknown
 * object type, no approval), the primary slot gets Ask Vex so there's
 * always a call to action.
 */
function actionsFor(priority: BriefPriority): CardAction[] {
  const actions: CardAction[] = [];
  if (priority.approvalId) {
    actions.push({
      label: "Review",
      href: `/app/approvals/${priority.approvalId}`,
      primary: true,
    });
  }
  const detail = detailHref(priority);
  if (detail) {
    actions.push({ label: "View", href: detail });
  }
  actions.push({
    label: "Ask Vex",
    href: askVexHref(priority),
    primary: actions.length === 0,
  });
  return actions;
}

export function PriorityCard({ priority, onAction }: PriorityCardProps) {
  const cardTint = URGENCY_CARD[priority.urgency];
  const barClass = URGENCY_BAR[priority.urgency];
  const dotClass = OBJECT_DOT[priority.objectType];
  const actions = actionsFor(priority);

  return (
    <article
      data-card="priority"
      data-urgency={priority.urgency}
      className={`relative rounded-lg border p-4 transition hover:bg-muted/20 ${cardTint}`}
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
          <div className="flex flex-wrap items-center gap-2">
            {actions.map((a) => (
              <Link
                key={a.label}
                href={a.href}
                {...(onAction ? { onClick: onAction } : {})}
                className={
                  a.primary
                    ? "rounded-md bg-accent px-3 py-1 text-xs font-medium text-bg transition-colors hover:bg-accent/85"
                    : "rounded-md border border-line bg-muted/40 px-3 py-1 text-xs text-white/80 transition hover:border-white/30 hover:text-white"
                }
              >
                {a.label}
              </Link>
            ))}
          </div>
        </div>
      </div>
    </article>
  );
}
