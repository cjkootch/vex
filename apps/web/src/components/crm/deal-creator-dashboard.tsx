"use client";

import type {
  CalculatorResponse,
  DealRecommendation,
  DealWarningSeverity,
  MarketRate,
} from "@/components/crm/deal-calculator-types";

export interface CalculatePayload {
  dealRef?: string;
  product?: string;
  incoterm?: string;
  paymentTerms?: string;
  volumeUsg?: number;
  densityKgL?: number;
  sellPricePerUsg?: number;
  productCostPerUsg?: number;
  freightPerUsg?: number;
  cargoInsurancePct?: number;
  dischargeHandlingPerUsg?: number;
  compliancePerUsg?: number;
  tradeFinancePerUsg?: number;
  intermediaryFeePerUsg?: number;
  vtcVariableOpsPerUsg?: number;
  counterpartyRiskScore?: number;
  countryRiskScore?: number;
  overheadAllocationUsd?: number;
}

interface Props {
  calc: CalculatorResponse | null;
  loading: boolean;
  benchmark: MarketRate | null;
  sellPricePerUsg: number | null;
}

/**
 * Right-pane live dashboard for the deal creator. Reads the pure
 * calculator output and surfaces:
 *   - Recommendation chip + overall score
 *   - Market benchmark comparison (sell vs Platts/OPIS)
 *   - KPI tiles: gross margin %, net margin $/USG, EBITDA $, peak cash
 *   - Warnings list, bucketed by severity
 *
 * "Missing economics" hint prompts the operator to fill sell price +
 * product cost before trusting the score.
 */
export function DealCreatorDashboard({
  calc,
  loading,
  benchmark,
  sellPricePerUsg,
}: Props) {
  const results = calc?.results ?? null;
  const missing = calc?.missingEconomicsFields ?? [];
  const hasEnoughInputs = missing.length === 0;

  return (
    <div className="flex flex-col gap-4">
      <header className="flex items-center justify-between">
        <div>
          <h3 className="text-sm font-semibold text-white">Deal quality</h3>
          <p className="text-xs text-white/50">
            {loading ? "Recomputing…" : hasEnoughInputs ? "Live score" : "Preview — fill economics"}
          </p>
        </div>
        {results && <ScoreBadge score={results.scorecard.overallScore} />}
      </header>

      {results && (
        <RecommendationChip
          recommendation={results.scorecard.recommendation}
          reason={results.scorecard.recommendationReason}
          suppressed={!hasEnoughInputs}
        />
      )}

      {benchmark && sellPricePerUsg !== null && sellPricePerUsg > 0 && (
        <BenchmarkChip benchmark={benchmark} sellPricePerUsg={sellPricePerUsg} />
      )}

      {!hasEnoughInputs && (
        <MissingInputsCallout missing={missing} />
      )}

      {results && (
        <KpiGrid
          grossMarginPct={results.totals.grossMarginPct}
          netMarginPerUsg={results.perUsg.netMargin}
          ebitdaUsd={results.totals.ebitdaUsd}
          peakCashUsd={results.cashflow.peakExposureUsd}
          revenueUsd={results.totals.revenueUsd}
          grossProfitUsd={results.totals.grossProfitUsd}
        />
      )}

      {results && results.warnings.length > 0 && (
        <WarningsList warnings={results.warnings} />
      )}

      {!results && !loading && (
        <p className="text-xs text-white/50">
          Calculator unavailable. Fill the required basics and try again.
        </p>
      )}
    </div>
  );
}

function ScoreBadge({ score }: { score: number }) {
  const tone =
    score >= 80
      ? "border-good/40 bg-good/10 text-good"
      : score >= 60
        ? "border-accent/40 bg-accent/10 text-accent"
        : score >= 40
          ? "border-warn/40 bg-warn/10 text-warn"
          : "border-bad/40 bg-bad/10 text-bad";
  return (
    <span
      className={`rounded-md border px-2 py-1 text-xs font-semibold tabular-nums ${tone}`}
      data-testid="deal-score"
    >
      {score.toFixed(0)} / 100
    </span>
  );
}

function RecommendationChip({
  recommendation,
  reason,
  suppressed,
}: {
  recommendation: DealRecommendation;
  reason: string;
  suppressed: boolean;
}) {
  const label: Record<DealRecommendation, string> = {
    strong: "Strong — proceed",
    acceptable: "Acceptable",
    marginal: "Marginal",
    do_not_proceed: "Do not proceed",
  };
  const tone: Record<DealRecommendation, string> = {
    strong: "border-good/40 bg-good/10 text-good",
    acceptable: "border-accent/40 bg-accent/10 text-accent",
    marginal: "border-warn/40 bg-warn/10 text-warn",
    do_not_proceed: "border-bad/40 bg-bad/10 text-bad",
  };
  return (
    <div
      className={`rounded-md border px-3 py-2 text-xs ${
        suppressed ? "border-line bg-muted/40 text-white/50" : tone[recommendation]
      }`}
    >
      <div className="font-semibold">
        {suppressed ? "Preview" : label[recommendation]}
      </div>
      <div className="mt-0.5 text-[11px] opacity-80">{reason}</div>
    </div>
  );
}

function BenchmarkChip({
  benchmark,
  sellPricePerUsg,
}: {
  benchmark: MarketRate;
  sellPricePerUsg: number;
}) {
  const spread = sellPricePerUsg - benchmark.pricePerUsg;
  const tone =
    spread >= 0.05
      ? "text-good"
      : spread >= 0
        ? "text-accent"
        : spread >= -0.05
          ? "text-warn"
          : "text-bad";
  const label = benchmark.benchmark.replace(/_/g, " ").toUpperCase();
  return (
    <div className="rounded-md border border-line bg-canvas/50 px-3 py-2 text-xs">
      <div className="flex items-center justify-between">
        <span className="text-white/60">{label}</span>
        <span className="tabular-nums text-white/80">
          ${benchmark.pricePerUsg.toFixed(4)} / USG
        </span>
      </div>
      <div className="mt-1 flex items-center justify-between">
        <span className="text-white/60">Your spread</span>
        <span className={`font-semibold tabular-nums ${tone}`}>
          {spread >= 0 ? "+" : ""}
          {spread.toFixed(4)} / USG
        </span>
      </div>
      <div className="mt-0.5 text-[10px] uppercase tracking-wide text-white/30">
        {benchmark.source} · {benchmark.rateDate}
      </div>
    </div>
  );
}

function MissingInputsCallout({ missing }: { missing: string[] }) {
  const label: Record<string, string> = {
    sellPricePerUsg: "Sell price",
    productCostPerUsg: "Product cost",
    volumeUsg: "Volume",
    freightPerUsg: "Freight",
  };
  return (
    <div className="rounded-md border border-warn/30 bg-warn/5 px-3 py-2 text-xs text-white/70">
      <div className="font-medium text-warn">Score is preview-only</div>
      <div className="mt-1">
        Add these to get a real recommendation:{" "}
        <span className="text-white">
          {missing.map((f) => label[f] ?? f).join(", ")}
        </span>
      </div>
    </div>
  );
}

function KpiGrid({
  grossMarginPct,
  netMarginPerUsg,
  ebitdaUsd,
  peakCashUsd,
  revenueUsd,
  grossProfitUsd,
}: {
  grossMarginPct: number;
  netMarginPerUsg: number;
  ebitdaUsd: number;
  peakCashUsd: number;
  revenueUsd: number;
  grossProfitUsd: number;
}) {
  return (
    <div className="grid grid-cols-2 gap-2">
      <Kpi
        label="Gross margin"
        value={`${(grossMarginPct * 100).toFixed(2)}%`}
        tone={grossMarginPct >= 0.05 ? "good" : grossMarginPct >= 0.02 ? "warn" : "bad"}
        footnote="target ≥ 5.00%"
      />
      <Kpi
        label="Net margin"
        value={`$${netMarginPerUsg.toFixed(4)} / USG`}
        tone={netMarginPerUsg >= 0.03 ? "good" : netMarginPerUsg >= 0.01 ? "warn" : "bad"}
        footnote="target ≥ $0.0300"
      />
      <Kpi label="EBITDA" value={formatUsd(ebitdaUsd)} />
      <Kpi
        label="Peak cash"
        value={formatUsd(peakCashUsd)}
        tone={peakCashUsd <= 5_000_000 ? "good" : peakCashUsd <= 7_500_000 ? "warn" : "bad"}
        footnote="cap $5.0M"
      />
      <Kpi label="Revenue" value={formatUsd(revenueUsd)} />
      <Kpi label="Gross profit" value={formatUsd(grossProfitUsd)} />
    </div>
  );
}

function Kpi({
  label,
  value,
  tone,
  footnote,
}: {
  label: string;
  value: string;
  tone?: "good" | "warn" | "bad";
  footnote?: string;
}) {
  const toneClass =
    tone === "good"
      ? "text-good"
      : tone === "warn"
        ? "text-warn"
        : tone === "bad"
          ? "text-bad"
          : "text-white";
  return (
    <div className="rounded-md border border-line bg-canvas/60 px-3 py-2">
      <div className="text-[10px] uppercase tracking-wide text-white/40">
        {label}
      </div>
      <div className={`mt-0.5 text-sm font-semibold tabular-nums ${toneClass}`}>
        {value}
      </div>
      {footnote && (
        <div className="text-[10px] text-white/30">{footnote}</div>
      )}
    </div>
  );
}

function WarningsList({
  warnings,
}: {
  warnings: {
    code: string;
    severity: DealWarningSeverity;
    message: string;
    affectedField: string;
  }[];
}) {
  const groups: Record<DealWarningSeverity, typeof warnings> = {
    critical: [],
    caution: [],
    info: [],
  };
  for (const w of warnings) groups[w.severity].push(w);
  return (
    <div className="flex flex-col gap-2">
      <div className="text-[10px] uppercase tracking-wide text-white/40">
        Flags
      </div>
      {(["critical", "caution", "info"] as const).map((severity) =>
        groups[severity].length === 0 ? null : (
          <div key={severity} className="flex flex-col gap-1">
            {groups[severity].map((w) => (
              <div
                key={`${severity}:${w.code}:${w.affectedField}`}
                className={`rounded-md border px-2 py-1.5 text-[11px] ${
                  severity === "critical"
                    ? "border-bad/40 bg-bad/10 text-bad"
                    : severity === "caution"
                      ? "border-warn/40 bg-warn/10 text-warn"
                      : "border-line bg-canvas/40 text-white/70"
                }`}
              >
                <div className="font-semibold tracking-tight">
                  {severity.toUpperCase()} · {w.code}
                </div>
                <div className="opacity-90">{w.message}</div>
              </div>
            ))}
          </div>
        ),
      )}
    </div>
  );
}

function formatUsd(value: number): string {
  if (Math.abs(value) >= 1_000_000) {
    return `$${(value / 1_000_000).toFixed(2)}M`;
  }
  if (Math.abs(value) >= 1_000) {
    return `$${(value / 1_000).toFixed(1)}k`;
  }
  return `$${value.toFixed(0)}`;
}
