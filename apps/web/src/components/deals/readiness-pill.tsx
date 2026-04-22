"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

/**
 * Compact readiness indicator for the deal-header row. Pulls from
 * the same /api/deals/:id/readiness endpoint the Readiness tab uses
 * and collapses the summary into a single tone + count pill:
 *
 *   blocked > 0        → red   · "N blocked"
 *   attention > 0      → amber · "N to fix"
 *   everything complete → green · "Ready"
 *
 * Click jumps into the deal's Readiness tab so the operator sees
 * the detail without hunting through tabs.
 */

interface ReadinessSummary {
  total: number;
  complete: number;
  blocked: number;
  attention: number;
}

interface ReadinessResponse {
  summary: ReadinessSummary;
}

export function ReadinessPill({
  dealId,
}: {
  dealId: string;
}): React.ReactElement | null {
  const [summary, setSummary] = useState<ReadinessSummary | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch(`/api/deals/${dealId}/readiness`)
      .then(async (res) => {
        if (!res.ok) throw new Error(String(res.status));
        return res.json();
      })
      .then((body: ReadinessResponse) => {
        if (!cancelled) setSummary(body.summary);
      })
      .catch(() => {
        // Quiet failure — the pill is supplementary; the full
        // Readiness tab will surface any fetch issue loudly.
      });
    return () => {
      cancelled = true;
    };
  }, [dealId]);

  if (!summary) return null;

  const { classes, label } = resolveTone(summary);

  return (
    <Link
      href={`/app/deals/${dealId}?tab=readiness`}
      className={`inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-xs transition-colors ${classes}`}
      title={`Readiness: ${summary.complete}/${summary.total} complete · ${summary.blocked} blocked · ${summary.attention} need attention`}
    >
      <span
        aria-hidden="true"
        className={`h-1.5 w-1.5 rounded-full ${dotFor(summary)}`}
      />
      {label}
    </Link>
  );
}

function resolveTone(s: ReadinessSummary): {
  classes: string;
  label: string;
} {
  if (s.blocked > 0) {
    return {
      classes:
        "border-red-500/60 bg-red-500/10 text-red-300 hover:bg-red-500/15",
      label: `${s.blocked} blocked`,
    };
  }
  if (s.attention > 0) {
    return {
      classes:
        "border-amber-500/60 bg-amber-500/10 text-amber-200 hover:bg-amber-500/15",
      label: `${s.attention} to fix`,
    };
  }
  return {
    classes:
      "border-emerald-500/50 bg-emerald-500/10 text-emerald-300 hover:bg-emerald-500/15",
    label: "Ready",
  };
}

function dotFor(s: ReadinessSummary): string {
  if (s.blocked > 0) return "bg-red-500";
  if (s.attention > 0) return "bg-amber-500";
  return "bg-emerald-400";
}
