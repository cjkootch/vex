"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { formatDistanceToNow } from "date-fns";
import { buildAskVexHref } from "@/lib/ask-vex";

/**
 * Per-deal pulse band. Renders a one-line execution summary above
 * the tabs: urgency tone + primary blocker / attention detail + a
 * "Next" action hint + time since last update.
 *
 * Driven by the same readiness endpoint as the Readiness tab, so
 * whatever the tab says, the pulse band mirrors in miniature.
 * Clicking "Ask Vex about this" opens chat pre-scoped to the deal
 * with the blocker in the prompt so operators can immediately dig
 * into why it's blocked.
 */

interface ReadinessCheck {
  id: string;
  label: string;
  state: "complete" | "stale" | "incomplete" | "missing" | "blocked";
  detail: string;
  lastVerifiedAt: string | null;
  ask: string;
}

interface ReadinessResponse {
  dealId: string;
  dealRef: string;
  status: string;
  summary: {
    total: number;
    complete: number;
    blocked: number;
    attention: number;
  };
  checks: ReadinessCheck[];
}

export function PulseBand({
  dealId,
  dealRef,
  updatedAt,
}: {
  dealId: string;
  dealRef: string;
  updatedAt: string | null;
}): React.ReactElement | null {
  const [data, setData] = useState<ReadinessResponse | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch(`/api/deals/${dealId}/readiness`)
      .then(async (r) => {
        if (!r.ok) throw new Error(String(r.status));
        return r.json();
      })
      .then((body: ReadinessResponse) => {
        if (!cancelled) setData(body);
      })
      .catch(() => {
        // Band is supplementary; the Readiness tab surfaces errors loudly.
      });
    return () => {
      cancelled = true;
    };
  }, [dealId]);

  if (!data) return null;

  const blocker = data.checks.find((c) => c.state === "blocked");
  const attention = data.checks.find(
    (c) => c.state === "stale" || c.state === "missing" || c.state === "incomplete",
  );
  const primary = blocker ?? attention ?? null;

  const nextAction = blocker
    ? "Resolve blocker before moving forward."
    : attention
      ? suggestNextForAttention(attention)
      : statusNextStep(data.status);

  const tone = blocker ? "blocker" : attention ? "attention" : "healthy";
  const toneClasses = toneStyles(tone);

  return (
    <section
      aria-label="Deal pulse"
      className={`flex flex-wrap items-start gap-3 rounded-lg border px-4 py-3 shadow-soft ${toneClasses.container}`}
    >
      <span
        aria-hidden="true"
        className={`mt-1 inline-block h-1.5 w-1.5 flex-shrink-0 rounded-full ${toneClasses.dot}`}
      />
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-baseline gap-2">
          <span className={`text-eyebrow ${toneClasses.eyebrow}`}>
            {tone === "blocker"
              ? "Blocker"
              : tone === "attention"
                ? "Attention"
                : "On track"}
          </span>
          {primary ? (
            <span className="text-sm text-text-primary/90">
              {primary.label}
              {primary.detail ? (
                <span className="text-text-secondary">
                  {" "}
                  · {primary.detail}
                </span>
              ) : null}
            </span>
          ) : (
            <span className="text-sm text-text-secondary">
              No blockers. Every readiness check is green.
            </span>
          )}
        </div>
        {nextAction ? (
          <div className="mt-1 flex flex-wrap items-baseline gap-1.5 text-xs">
            <span className="text-eyebrow text-accent-strong">Next</span>
            <span className="text-text-primary/90">{nextAction}</span>
          </div>
        ) : null}
      </div>
      <div className="flex flex-shrink-0 items-center gap-2">
        {updatedAt ? (
          <span className="num text-[11px] text-text-muted">
            {formatDistanceToNow(new Date(updatedAt), { addSuffix: true })}
          </span>
        ) : null}
        <Link
          href={buildAskVexHref({
            type: "deal",
            id: dealId,
            label: dealRef,
            ask: primary
              ? `On deal ${dealRef}: ${primary.label} is ${primary.state}${primary.detail ? ` — ${primary.detail}` : ""}. What should I do next?`
              : `What should I focus on next for deal ${dealRef}?`,
          })}
          className="rounded-md bg-accent px-2.5 py-1 text-[11px] font-medium text-bg transition-colors hover:bg-accent/85"
        >
          Ask Vex
        </Link>
      </div>
    </section>
  );
}

function toneStyles(tone: "blocker" | "attention" | "healthy"): {
  container: string;
  dot: string;
  eyebrow: string;
} {
  if (tone === "blocker") {
    return {
      container: "border-bad/45 bg-bad/[0.05]",
      dot: "bg-bad shadow-[0_0_6px_currentColor]",
      eyebrow: "text-bad",
    };
  }
  if (tone === "attention") {
    return {
      container: "border-warn/45 bg-warn/[0.05]",
      dot: "bg-warn shadow-[0_0_6px_currentColor]",
      eyebrow: "text-warn",
    };
  }
  return {
    container: "border-emerald-400/30 bg-emerald-400/[0.04]",
    dot: "bg-emerald-400 shadow-[0_0_6px_currentColor]",
    eyebrow: "text-emerald-300",
  };
}

function suggestNextForAttention(c: ReadinessCheck): string {
  switch (c.id) {
    case "ofac":
      return "Re-run OFAC screening on the counterparties.";
    case "counterparty":
      return "Review why the counterparty lands in its current tier.";
    case "freight":
      return "Pull a fresh freight quote for this lane.";
    case "vessel":
      return "Select a vessel for this deal.";
    case "docs":
      return "Collect the missing required documents.";
    case "milestone":
      return "Assign the next milestone and set a due date.";
    case "kyc":
      return "Upload the term sheet or SPA.";
    case "payment":
      return "Confirm payment terms.";
    default:
      return "Address the outstanding attention item.";
  }
}

function statusNextStep(status: string): string | null {
  switch (status) {
    case "draft":
      return "Confirm terms and move to Negotiating.";
    case "negotiating":
      return "Lock terms and request approval.";
    case "pending_approval":
      return "Awaiting approval — nudge reviewer if stale.";
    case "approved":
      return "Select vessel and lock freight.";
    case "loading":
      return "Confirm BL issued and cargo loaded.";
    case "in_transit":
      return "Track vessel; prepare arrival docs.";
    case "delivered":
      return "Collect final payment + settle.";
    default:
      return null;
  }
}
