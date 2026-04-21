"use client";

import type {
  BuyerIntel,
  CalculatorResponse,
  DealRecommendation,
  DealWarningSeverity,
  MarketRate,
  SensitivityGrid,
} from "@/components/crm/deal-calculator-types";
import {
  commissionPerUsg,
  type ParticipantDraft,
} from "@/components/crm/participant-editor";

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
  buyerIntel: BuyerIntel | null;
  sellPricePerUsg: number | null;
  /** Sum of every participant commission converted to $/USG. */
  participantFeePerUsg?: number;
  /** Participant rows driving that sum, for per-row attribution. */
  participants?: ParticipantDraft[];
  /** Inputs the per-USG conversion depends on. Used to recompute per
   *  row for the attribution breakdown shown in the dashboard. */
  participantContext?: {
    sellPricePerUsg?: number;
    densityKgL?: number;
    volumeUsg?: number;
  };
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
  buyerIntel,
  sellPricePerUsg,
  participantFeePerUsg,
  participants,
  participantContext,
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

      {buyerIntel && <BuyerIntelCard intel={buyerIntel} />}

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

      {participants && participants.length > 0 && (
        <ParticipantBreakdown
          participants={participants}
          total={participantFeePerUsg ?? 0}
          ctx={participantContext ?? {}}
        />
      )}

      {results && results.warnings.length > 0 && (
        <WarningsList warnings={results.warnings} />
      )}

      {results?.sensitivity?.freightRateSweep &&
        results.sensitivity.freightRateSweep.values.length > 0 && (
          <FreightSweepCard grid={results.sensitivity.freightRateSweep} />
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

function BuyerIntelCard({ intel }: { intel: BuyerIntel }) {
  const cp = intel.counterparty;
  const share = intel.concentration.buyerShare;
  const overConcentrated = share >= 0.4;
  const approaching = share >= 0.25 && share < 0.4;
  // Tier tone mirrors the counterparty_risk_tier enum values: tier_1
  // is healthy, tier_3 is risky, watch/declined are hard stops.
  const tierTone: Record<string, string> = {
    tier_1: "border-good/40 bg-good/10 text-good",
    tier_2: "border-accent/40 bg-accent/10 text-accent",
    tier_3: "border-warn/40 bg-warn/10 text-warn",
    watch: "border-warn/40 bg-warn/10 text-warn",
    declined: "border-bad/40 bg-bad/10 text-bad",
  };

  return (
    <div className="flex flex-col gap-2 rounded-md border border-line bg-canvas/50 px-3 py-2 text-xs">
      <div className="flex items-center justify-between">
        <span className="text-[10px] uppercase tracking-wide text-white/40">
          Buyer intel
        </span>
        {cp ? (
          <span
            className={`rounded-md border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${
              tierTone[cp.riskTier] ?? "border-line bg-muted/40 text-white/60"
            }`}
          >
            {cp.riskTier.replace(/_/g, " ")}
          </span>
        ) : (
          <span className="text-[10px] italic text-white/40">unscored</span>
        )}
      </div>

      {cp ? (
        <div className="grid grid-cols-2 gap-2">
          <IntelTile
            label="Composite"
            value={`${cp.compositeScore.toFixed(0)} / 100`}
            footnote="higher = riskier"
          />
          <IntelTile
            label="Max exposure"
            value={
              cp.recommendedMaxExposureUsd !== null
                ? formatIntelUsd(cp.recommendedMaxExposureUsd)
                : "—"
            }
            footnote="recommended"
          />
          <IntelTile
            label="Terms"
            value={
              cp.recommendedPaymentTerms?.replace(/_/g, " ") ?? "—"
            }
            footnote="recommended"
          />
          <IntelTile
            label="Credit / country"
            value={`${cp.creditRisk.toFixed(0)} / ${cp.countryRisk.toFixed(0)}`}
            footnote="dim. scores"
          />
        </div>
      ) : (
        <p className="text-white/60">
          No counterparty score on file. Deal can still be saved; consider
          running a KYC / risk assessment before approval.
        </p>
      )}

      <div
        className={`rounded-md border px-2 py-1.5 text-[11px] ${
          overConcentrated
            ? "border-bad/40 bg-bad/10 text-bad"
            : approaching
              ? "border-warn/40 bg-warn/10 text-warn"
              : "border-line bg-canvas/40 text-white/70"
        }`}
      >
        <div className="font-semibold">
          {overConcentrated
            ? "Concentration alert"
            : approaching
              ? "Concentration approaching cap"
              : "Pipeline concentration"}
        </div>
        <div className="opacity-90">
          {intel.concentration.openDealCount > 0 && intel.concentration.totalOpenVolumeUsg > 0
            ? `${(share * 100).toFixed(1)}% of open pipeline by volume (${intel.concentration.openDealCount} open ${intel.concentration.openDealCount === 1 ? "deal" : "deals"})`
            : "No open deals with this buyer yet"}
        </div>
        {overConcentrated && (
          <div className="mt-0.5 opacity-80">
            &gt; 40% triggers a caution warning on the calculator. Consider
            deferring or splitting the deal.
          </div>
        )}
      </div>
    </div>
  );
}

function IntelTile({
  label,
  value,
  footnote,
}: {
  label: string;
  value: string;
  footnote?: string;
}) {
  return (
    <div className="rounded-md border border-line bg-canvas/60 px-2 py-1.5">
      <div className="text-[10px] uppercase tracking-wide text-white/40">
        {label}
      </div>
      <div className="mt-0.5 text-xs font-semibold text-white tabular-nums">
        {value}
      </div>
      {footnote && (
        <div className="text-[10px] text-white/30">{footnote}</div>
      )}
    </div>
  );
}

function formatIntelUsd(value: number): string {
  if (Math.abs(value) >= 1_000_000) {
    return `$${(value / 1_000_000).toFixed(2)}M`;
  }
  if (Math.abs(value) >= 1_000) {
    return `$${(value / 1_000).toFixed(0)}k`;
  }
  return `$${value.toFixed(0)}`;
}

function FreightSweepCard({ grid }: { grid: SensitivityGrid }) {
  // 2 rows: EBITDA, Peak cash. 9 cols: -20% .. +20% in 5% steps.
  const [ebitdaRow, peakCashRow] = grid.values;
  if (!ebitdaRow || !peakCashRow) return null;
  const baselineIdx = grid.highlightCol >= 0 ? grid.highlightCol : 4;
  const ebitdaBase = ebitdaRow[baselineIdx] ?? 0;
  const peakBase = peakCashRow[baselineIdx] ?? 0;

  return (
    <div className="flex flex-col gap-2 rounded-md border border-line bg-canvas/40 px-3 py-2 text-xs">
      <div className="flex items-center justify-between text-white/60">
        <span className="text-[10px] uppercase tracking-wide">
          Freight ±20% sensitivity
        </span>
        <span className="text-[10px] text-white/40">vs baseline</span>
      </div>

      <SweepRow
        label="EBITDA"
        cells={ebitdaRow}
        baseline={ebitdaBase}
        labels={grid.colLabels}
        baselineIdx={baselineIdx}
        // EBITDA falling is bad — flip the polarity so red = bad.
        invertPolarity={false}
      />
      <SweepRow
        label="Peak cash"
        cells={peakCashRow}
        baseline={peakBase}
        labels={grid.colLabels}
        baselineIdx={baselineIdx}
        // Peak cash going up = bigger exposure = bad. Same polarity.
        invertPolarity
      />
    </div>
  );
}

function SweepRow({
  label,
  cells,
  baseline,
  labels,
  baselineIdx,
  invertPolarity,
}: {
  label: string;
  cells: number[];
  baseline: number;
  labels: string[];
  baselineIdx: number;
  /** When true, an INCREASE vs baseline is treated as bad (e.g. peak cash). */
  invertPolarity: boolean;
}) {
  return (
    <div className="flex flex-col gap-0.5">
      <div className="text-[10px] uppercase tracking-wide text-white/40">
        {label}
      </div>
      <div className="flex items-stretch gap-px overflow-hidden rounded">
        {cells.map((value, i) => {
          const delta = baseline !== 0 ? (value - baseline) / Math.abs(baseline) : 0;
          const adjusted = invertPolarity ? -delta : delta;
          const tone =
            i === baselineIdx
              ? "bg-white/20 text-white"
              : adjusted >= 0.05
                ? "bg-good/20 text-good"
                : adjusted <= -0.05
                  ? "bg-bad/20 text-bad"
                  : "bg-canvas/60 text-white/70";
          return (
            <div
              key={i}
              className={`flex flex-1 flex-col items-center px-1 py-1 text-[10px] tabular-nums ${tone}`}
              title={`${labels[i]}: ${formatUsd(value)}`}
            >
              <span className="opacity-60">{labels[i]}</span>
              <span className="font-semibold">{formatUsd(value)}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function ParticipantBreakdown({
  participants,
  total,
  ctx,
}: {
  participants: ParticipantDraft[];
  total: number;
  ctx: { sellPricePerUsg?: number; densityKgL?: number; volumeUsg?: number };
}) {
  const rows = participants
    .filter((p) => p.displayName.trim().length > 0)
    .map((p) => ({
      p,
      perUsg: commissionPerUsg(p, ctx),
    }));
  const label: Record<string, string> = {
    supplier: "Supplier",
    supplier_broker: "Supplier-side broker",
    buyer: "Buyer",
    buyer_broker: "Buyer-side broker",
    intermediary: "Intermediary",
  };
  return (
    <div className="flex flex-col gap-1 rounded-md border border-line bg-canvas/40 px-3 py-2 text-[11px]">
      <div className="flex items-center justify-between text-white/40">
        <span className="uppercase tracking-wide">Commissions</span>
        <span className="tabular-nums text-white/80">
          ${total.toFixed(4)} / USG
        </span>
      </div>
      {rows.map(({ p, perUsg }) => (
        <div
          key={p.key}
          className="flex items-center justify-between text-white/70"
        >
          <span className="truncate pr-2">
            {p.displayName}
            <span className="text-white/40"> · {label[p.partyType] ?? p.partyType}</span>
          </span>
          <span className="tabular-nums">
            {perUsg === null
              ? <span className="text-white/40">—</span>
              : `$${perUsg.toFixed(4)}`}
          </span>
        </div>
      ))}
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
