"use client";

import { useRouter } from "next/navigation";
import type { KeyboardEvent } from "react";
import type { BriefPipelineItem } from "@vex/domain";

/**
 * One row in the home-screen pipeline section. Compact table-row
 * layout (ref · product · buyer · status · EBITDA · score · last
 * touch · warnings). Whole row is keyboard-actionable and navigates
 * to /app/chat with a pre-filled ?ask=Show me deal {ref} query.
 * The chat page (follow-up change set) reads the param, sends the
 * message, and the resulting manifest includes a
 * workspace_mode_switch panel that opens the deal war room.
 */

export interface DealPipelineRowProps {
  deal: BriefPipelineItem;
}

// Status → pill colour. Deal-status values come from the deal_status
// enum; any unexpected string falls back to the neutral style.
const STATUS_TONE: Record<string, string> = {
  draft: "border-white/20 bg-white/5 text-white/60",
  negotiating: "border-amber-500/40 bg-amber-500/10 text-amber-200",
  pending_approval: "border-purple-400/40 bg-purple-500/10 text-purple-200",
  approved: "border-emerald-400/40 bg-emerald-500/10 text-emerald-200",
  loading: "border-blue-400/40 bg-blue-500/10 text-blue-200",
  in_transit: "border-blue-400/40 bg-blue-500/10 text-blue-200",
  delivered: "border-emerald-400/40 bg-emerald-500/10 text-emerald-200",
  settled: "border-emerald-400/40 bg-emerald-500/10 text-emerald-200",
  cancelled: "border-red-500/40 bg-red-500/10 text-red-200",
  failed: "border-red-500/40 bg-red-500/10 text-red-200",
};

const DEFAULT_STATUS_TONE = "border-line bg-muted/40 text-white/60";

function statusLabel(status: string): string {
  return status.replace(/_/g, " ");
}

function productLabel(product: string): string {
  return product.replace(/_/g, " ").toUpperCase();
}

function formatCompactUsd(n: number): string {
  const abs = Math.abs(n);
  const sign = n < 0 ? "-" : "";
  if (abs >= 1_000_000) return `${sign}$${(abs / 1_000_000).toFixed(1)}M`;
  if (abs >= 1_000) return `${sign}$${Math.round(abs / 1_000)}k`;
  return `${sign}$${Math.round(abs)}`;
}

function formatLastTouch(days: number): string {
  if (days <= 0) return "today";
  if (days === 1) return "1d ago";
  return `${days}d ago`;
}

function lastTouchTone(days: number): string {
  if (days > 14) return "text-red-300";
  if (days > 5) return "text-amber-300";
  return "text-white/40";
}

function scoreTone(score: number): string {
  if (score < 40) return "text-red-400";
  if (score < 60) return "text-amber-400";
  return "text-emerald-400";
}

export function DealPipelineRow({ deal }: DealPipelineRowProps) {
  const router = useRouter();
  const href = `/app/chat?ask=${encodeURIComponent(`Show me deal ${deal.dealRef}`)}`;
  const go = (): void => {
    router.push(href);
  };
  const onKey = (e: KeyboardEvent<HTMLElement>): void => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      go();
    }
  };

  const statusTone = STATUS_TONE[deal.status] ?? DEFAULT_STATUS_TONE;

  return (
    <div
      data-row="deal-pipeline"
      role="button"
      tabIndex={0}
      onClick={go}
      onKeyDown={onKey}
      className="flex cursor-pointer items-center gap-4 px-4 py-3 text-sm transition hover:bg-white/5 focus-visible:bg-white/5 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-white/40"
    >
      <div className="min-w-[180px] flex-shrink-0">
        <span className="font-medium text-white">{deal.dealRef}</span>
        <span aria-hidden="true" className="mx-2 text-white/30">
          ·
        </span>
        <span className="text-xs text-white/50">{productLabel(deal.product)}</span>
      </div>

      <div className="min-w-0 flex-1 truncate text-white/70">{deal.buyer}</div>

      <span
        className={`flex-shrink-0 rounded-full border px-2 py-0.5 text-xs ${statusTone}`}
      >
        {statusLabel(deal.status)}
      </span>

      <div
        className={`w-20 flex-shrink-0 text-right font-medium ${
          deal.ebitdaUsd >= 0 ? "text-emerald-300" : "text-red-300"
        }`}
      >
        {formatCompactUsd(deal.ebitdaUsd)}
      </div>

      <ScoreGauge score={deal.score} />

      <div
        className={`w-16 flex-shrink-0 text-right text-xs ${lastTouchTone(deal.daysSinceLastTouch)}`}
      >
        {formatLastTouch(deal.daysSinceLastTouch)}
      </div>

      <div className="w-8 flex-shrink-0 text-right">
        {deal.criticalWarningCount > 0 ? (
          <span
            aria-label={`${deal.criticalWarningCount} critical warning${deal.criticalWarningCount === 1 ? "" : "s"}`}
            className="inline-flex h-5 min-w-[1.25rem] items-center justify-center rounded-full bg-red-500/20 px-1.5 text-xs text-red-300"
          >
            {deal.criticalWarningCount}
          </span>
        ) : (
          <span aria-hidden="true" className="text-xs text-white/20">
            —
          </span>
        )}
      </div>
    </div>
  );
}

// Tiny SVG donut, 32x32. Circumference = 2π·14 ≈ 87.96; dasharray
// fills the fraction clockwise from 12 o'clock via the -90° rotate.
function ScoreGauge({ score }: { score: number }) {
  const clamped = Math.max(0, Math.min(100, Math.round(score)));
  const circumference = 2 * Math.PI * 14;
  const filled = (clamped / 100) * circumference;
  const tone = scoreTone(clamped);
  return (
    <svg
      width="32"
      height="32"
      viewBox="0 0 32 32"
      className="flex-shrink-0"
      role="img"
      aria-label={`Deal score ${clamped} out of 100`}
    >
      <circle cx="16" cy="16" r="14" fill="none" className="stroke-white/10" strokeWidth="3" />
      <circle
        cx="16"
        cy="16"
        r="14"
        fill="none"
        className={`${tone} stroke-current`}
        strokeWidth="3"
        strokeLinecap="round"
        strokeDasharray={`${filled} ${circumference}`}
        transform="rotate(-90 16 16)"
      />
      <text
        x="16"
        y="17"
        textAnchor="middle"
        fontSize="10"
        fontWeight="500"
        className="fill-white"
      >
        {clamped}
      </text>
    </svg>
  );
}
