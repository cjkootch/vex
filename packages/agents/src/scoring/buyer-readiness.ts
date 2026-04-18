/**
 * Buyer-readiness scoring — a pure, deterministic 0-100 score that ranks
 * counterparties on likelihood-to-close for a given market moment. The
 * MarketAlertAgent consumes this to decide which buyers warrant outreach
 * when a threshold crossing fires.
 *
 * The score is intentionally additive and capped per dimension so a
 * single perfect signal can't dominate. A rationale array reports which
 * dimensions contributed, which callers surface in the approval proposal
 * so a reviewer can eyeball "why this buyer".
 *
 * Inputs are shaped to match what a caller can cheaply gather from our
 * repositories — no LLM, no provider fetches. The scorer is pure so the
 * unit tests can pin exact values.
 */

export type RiskTier = "low" | "medium" | "high" | "prohibited";

export interface BuyerReadinessSignals {
  /**
   * Counterparty risk tier. `prohibited` forces a floor score of 0 and
   * emits a blocking rationale — the agent should never propose outreach
   * regardless of other signals.
   */
  counterpartyTier: RiskTier | null;
  /**
   * Counterparty composite score (0-100, higher = riskier). Used for
   * finer-grained ranking within a tier. Absent when no assessment
   * exists — treated as neutral.
   */
  counterpartyComposite: number | null;
  /** Total relevant touchpoints in the last 30 days. */
  touchpointCount30d: number;
  /** Days since the last inbound touchpoint — lower is fresher. Null = never. */
  daysSinceLastInbound: number | null;
  /** Open follow-up approvals for this buyer. Signals active momentum. */
  openFollowUpCount: number;
  /** Count of deals already in progress with this buyer. */
  activeDealCount: number;
  /**
   * Price-delta favorability for the product this buyer has historically
   * bought. Range -1..+1, where +1 = current spot far below the buyer's
   * typical purchase level (their cost-basis would improve), -1 = far
   * above (outreach untimely). Null when history is too thin.
   */
  priceFavorability: number | null;
}

export interface BuyerReadinessContribution {
  dimension: string;
  points: number;
  note: string;
}

export interface BuyerReadinessResult {
  /** 0-100 integer score. Rounded; clamped. */
  score: number;
  /** Qualitative band for quick filtering. */
  band: "cold" | "watch" | "warm" | "hot";
  /** Non-empty list explaining where the score came from. */
  contributions: BuyerReadinessContribution[];
  /**
   * When true, the caller MUST NOT propose outreach regardless of score —
   * prohibited counterparties, sanction hits, etc.
   */
  blocked: boolean;
  /** Machine-readable block reason when `blocked === true`. */
  blockReason?: string;
}

/**
 * Per-dimension point ceilings. The total ceiling is 100 so every
 * dimension can be fully awarded without exceeding the band thresholds.
 */
const CEILINGS = {
  counterpartyTier: 30,
  touchpoints: 20,
  recency: 15,
  momentum: 15,
  priceFavorability: 20,
} as const;

const BAND_THRESHOLDS = {
  hot: 75,
  warm: 50,
  watch: 25,
} as const;

export function scoreBuyerReadiness(signals: BuyerReadinessSignals): BuyerReadinessResult {
  const contributions: BuyerReadinessContribution[] = [];

  if (signals.counterpartyTier === "prohibited") {
    return {
      score: 0,
      band: "cold",
      contributions: [
        {
          dimension: "counterparty_tier",
          points: 0,
          note: "counterparty tier is prohibited — outreach blocked",
        },
      ],
      blocked: true,
      blockReason: "counterparty_prohibited",
    };
  }

  contributions.push(tierContribution(signals));
  contributions.push(touchpointContribution(signals));
  contributions.push(recencyContribution(signals));
  contributions.push(momentumContribution(signals));
  contributions.push(priceContribution(signals));

  const raw = contributions.reduce((sum, c) => sum + c.points, 0);
  const score = clamp(Math.round(raw), 0, 100);

  return {
    score,
    band: bandFor(score),
    contributions,
    blocked: false,
  };
}

function tierContribution(signals: BuyerReadinessSignals): BuyerReadinessContribution {
  const tier = signals.counterpartyTier;
  if (tier === null) {
    return {
      dimension: "counterparty_tier",
      points: 10,
      note: "no risk assessment on file — neutral baseline",
    };
  }
  if (tier === "prohibited") {
    // Callers hit this only when a caller reuses tierContribution in
    // isolation — the top-level scorer short-circuits prohibited.
    return {
      dimension: "counterparty_tier",
      points: 0,
      note: "tier=prohibited",
    };
  }
  // Tier drives the baseline; composite nudges within the tier. Baseline
  // leaves 4 points of headroom under the ceiling so a pristine composite
  // can push a low-tier buyer to the dimension cap.
  const tierBase = { low: 26, medium: 16, high: 6 } as const;
  const tierPoints = tierBase[tier];
  const compositeAdjustment = adjustForComposite(signals.counterpartyComposite);
  const points = clamp(tierPoints + compositeAdjustment, 0, CEILINGS.counterpartyTier);
  return {
    dimension: "counterparty_tier",
    points,
    note: `tier=${signals.counterpartyTier}${
      signals.counterpartyComposite !== null
        ? ` composite=${signals.counterpartyComposite.toFixed(0)}`
        : ""
    }`,
  };
}

function adjustForComposite(composite: number | null): number {
  if (composite === null) return 0;
  // Composite: 0 = very low risk → +4; 100 = very high risk → -4.
  return Math.round(((50 - composite) / 50) * 4);
}

function touchpointContribution(signals: BuyerReadinessSignals): BuyerReadinessContribution {
  const tp = signals.touchpointCount30d;
  let points: number;
  if (tp >= 15) points = CEILINGS.touchpoints;
  else if (tp >= 8) points = 16;
  else if (tp >= 4) points = 10;
  else if (tp >= 1) points = 5;
  else points = 0;
  return {
    dimension: "touchpoints_30d",
    points,
    note: `${tp} touchpoint(s) in last 30d`,
  };
}

function recencyContribution(signals: BuyerReadinessSignals): BuyerReadinessContribution {
  const d = signals.daysSinceLastInbound;
  if (d === null) {
    return {
      dimension: "recency",
      points: 0,
      note: "no inbound ever",
    };
  }
  let points: number;
  if (d <= 3) points = CEILINGS.recency;
  else if (d <= 7) points = 11;
  else if (d <= 14) points = 7;
  else if (d <= 30) points = 3;
  else points = 0;
  return {
    dimension: "recency",
    points,
    note: `last inbound ${d}d ago`,
  };
}

function momentumContribution(signals: BuyerReadinessSignals): BuyerReadinessContribution {
  // Either open follow-ups or active deals signal momentum; both stacks
  // but can't exceed the ceiling. Open approvals are a stronger signal
  // than deals-in-progress (those may be stalled).
  const followUps = Math.min(signals.openFollowUpCount, 3) * 3;
  const deals = Math.min(signals.activeDealCount, 3) * 2;
  const points = clamp(followUps + deals, 0, CEILINGS.momentum);
  return {
    dimension: "momentum",
    points,
    note: `${signals.openFollowUpCount} open follow-up(s), ${signals.activeDealCount} active deal(s)`,
  };
}

function priceContribution(signals: BuyerReadinessSignals): BuyerReadinessContribution {
  const favor = signals.priceFavorability;
  if (favor === null) {
    return {
      dimension: "price_favorability",
      points: 0,
      note: "insufficient price history",
    };
  }
  // Favorability is -1..+1. Map linearly to 0..CEILING, with zero at +0.
  // Unfavorable markets contribute 0 rather than penalising the buyer —
  // readiness is about *this* buyer, market timing is a separate
  // concern the caller surfaces in the outreach prompt.
  const normalized = clamp(favor, -1, 1);
  const points = clamp(Math.round(((normalized + 1) / 2) * CEILINGS.priceFavorability), 0, CEILINGS.priceFavorability);
  return {
    dimension: "price_favorability",
    points,
    note: `favorability=${normalized.toFixed(2)}`,
  };
}

function bandFor(score: number): BuyerReadinessResult["band"] {
  if (score >= BAND_THRESHOLDS.hot) return "hot";
  if (score >= BAND_THRESHOLDS.warm) return "warm";
  if (score >= BAND_THRESHOLDS.watch) return "watch";
  return "cold";
}

function clamp(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, n));
}
