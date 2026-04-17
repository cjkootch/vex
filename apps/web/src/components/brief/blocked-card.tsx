"use client";

import Link from "next/link";
import type { BriefBlockedItem, BriefRisk } from "@vex/domain";

/**
 * Two small home-screen cards rendered below their respective
 * brief sections. BlockedCard surfaces something Vex tried to do
 * and couldn't; RiskCard surfaces watch-list items that haven't
 * crossed into blocking yet.
 *
 * Both reuse the shared ObjectChip so "jump to the related object"
 * works the same way across the home screen.
 */

// ---------------------------------------------------------------------------
// Shared — object chip (clickable pill) + dot palette.
// ---------------------------------------------------------------------------

const OBJECT_DOT: Record<string, string> = {
  deal: "bg-teal-400",
  organization: "bg-blue-400",
  contact: "bg-purple-400",
  approval: "bg-amber-400",
  campaign: "bg-emerald-400",
};

function objectHref(objectType: string, objectId: string): string | null {
  if (objectType === "deal") {
    return `/app/chat?ask=${encodeURIComponent(`Show me deal ${objectId}`)}`;
  }
  if (objectType === "organization") {
    return `/app/chat?ask=${encodeURIComponent(`Show me organization ${objectId}`)}`;
  }
  return null;
}

function ObjectChip({
  objectType,
  objectId,
  label,
}: {
  objectType: string;
  objectId: string;
  label?: string;
}) {
  const dot = OBJECT_DOT[objectType] ?? "bg-white/30";
  const href = objectHref(objectType, objectId);
  const text = label ?? `${objectType} · ${objectId}`;
  const inner = (
    <span className="inline-flex items-center gap-2 rounded-full border border-line bg-canvas/40 px-2 py-0.5 text-xs text-white/70">
      <span aria-hidden="true" className={`h-1.5 w-1.5 rounded-full ${dot}`} />
      {text}
    </span>
  );
  if (!href) return inner;
  return (
    <Link
      href={href}
      onClick={(e) => e.stopPropagation()}
      className="inline-block transition hover:text-white"
    >
      {inner}
    </Link>
  );
}

// ---------------------------------------------------------------------------
// BlockedCard
// ---------------------------------------------------------------------------

export interface BlockedCardProps {
  item: BriefBlockedItem;
}

/**
 * Amber left border + subtle amber tint. When the item carries a
 * resolution hint, surface it in an amber callout box below the
 * reason so the user sees the unblock action without scanning the
 * whole card.
 */
export function BlockedCard({ item }: BlockedCardProps) {
  return (
    <article
      data-card="blocked"
      className="relative rounded-lg border border-amber-500/40 bg-amber-500/5 p-4"
    >
      <div
        aria-hidden="true"
        className="absolute left-0 top-0 h-full w-1 rounded-l-lg bg-amber-500"
      />
      <div className="pl-2">
        <h3 className="font-semibold text-white">{item.summary}</h3>
        <p className="mt-1 text-sm text-white/60">{item.reason}</p>
        {item.resolution ? (
          <div className="mt-3 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-200">
            <span className="mr-1 font-medium">To unblock:</span>
            {item.resolution}
          </div>
        ) : null}
        <div className="mt-3">
          <ObjectChip
            objectType={item.objectType}
            objectId={item.objectId}
          />
        </div>
      </div>
    </article>
  );
}

// ---------------------------------------------------------------------------
// RiskCard
// ---------------------------------------------------------------------------

export interface RiskCardProps {
  risk: BriefRisk;
}

const RISK_BORDER: Record<BriefRisk["severity"], string> = {
  high: "border-red-500/50 bg-red-500/5",
  medium: "border-amber-500/40 bg-amber-500/5",
};

const RISK_BAR: Record<BriefRisk["severity"], string> = {
  high: "bg-red-500",
  medium: "bg-amber-500",
};

/**
 * Red left border for high severity, amber for medium. Description
 * is clamped to two lines so the card height stays predictable in
 * the grid of risks.
 */
export function RiskCard({ risk }: RiskCardProps) {
  const borderClass = RISK_BORDER[risk.severity];
  const barClass = RISK_BAR[risk.severity];
  return (
    <article
      data-card="risk"
      data-severity={risk.severity}
      className={`relative rounded-lg border p-4 ${borderClass}`}
    >
      <div
        aria-hidden="true"
        className={`absolute left-0 top-0 h-full w-1 rounded-l-lg ${barClass}`}
      />
      <div className="pl-2">
        <h3 className="font-semibold text-white">{risk.title}</h3>
        <p className="mt-1 line-clamp-2 text-sm text-white/60">
          {risk.description}
        </p>
        <div className="mt-3">
          <ObjectChip
            objectType={risk.objectType}
            objectId={risk.objectId}
          />
        </div>
      </div>
    </article>
  );
}
