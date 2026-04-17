/**
 * Daily brief domain types.
 *
 * The DailyBrief is the canonical shape for the /app home-screen
 * payload. The DailyBriefAgent writes it to `summaries.content` as
 * JSON under `summary_type = "daily_brief"`; the web brief endpoint
 * reads the same row and augments two live fields
 * (`pendingApprovalCount`, `totalAgentCostToday`) before serving.
 *
 * Pure types — no DB imports, no HTTP. Safe for agents, api, and web.
 */

// ---------------------------------------------------------------------------
// Sections of the home screen. The enum is authoritative — UI component
// rendering keys off these literals so a new section can't accidentally
// be introduced without the renderer knowing how to show it.
// ---------------------------------------------------------------------------

export const DailyBriefSection = {
  Priorities: "priorities",
  Handled: "handled",
  Blocked: "blocked",
  OwnerOnly: "owner_only",
  Pipeline: "pipeline",
  Risks: "risks",
  Focus: "focus",
} as const;
export type DailyBriefSection =
  (typeof DailyBriefSection)[keyof typeof DailyBriefSection];

// ---------------------------------------------------------------------------
// Item-level types. Each carries the minimum data the home-screen cards
// need; richer detail (full timelines, full scorecards) lives behind the
// `objectId` lookup. Keeps the brief payload compact enough to cache.
// ---------------------------------------------------------------------------

export type BriefUrgency = "high" | "medium" | "low";

/**
 * Something the human owner should act on. May or may not carry a
 * suggested action; when `approvalId` is present the UI routes the
 * action through the approval inbox rather than free-form chat.
 */
export interface BriefPriority {
  id: string;
  title: string;
  reason: string;
  objectType: "deal" | "organization" | "contact" | "approval" | "campaign";
  objectId: string;
  objectRef?: string;
  urgency: BriefUrgency;
  suggestedAction?: string;
  approvalId?: string;
}

/** A thing Vex did for you in the last 24h. Always completed; failures
 *  go into `blocked` instead. */
export interface BriefHandledItem {
  id: string;
  agentName: string;
  summary: string;
  completedAt: string;
  costUsd: number;
}

/**
 * A thing Vex wanted to do but couldn't. `resolution` is the human-
 * facing instruction for unsticking it — when missing the card renders
 * the reason alone.
 */
export interface BriefBlockedItem {
  id: string;
  summary: string;
  reason: string;
  objectType: string;
  objectId: string;
  resolution?: string;
}

/** Compact row in the home-screen pipeline table. Derived from the
 *  latest active fuel_deal_scenario per deal. */
export interface BriefPipelineItem {
  dealId: string;
  dealRef: string;
  product: string;
  buyer: string;
  status: string;
  ebitdaUsd: number;
  score: number;
  recommendation: string;
  daysSinceLastTouch: number;
  criticalWarningCount: number;
}

export type BriefRiskSeverity = "high" | "medium";

/** Watch-list item. Not an action the user must take today — just a
 *  flag that something's drifting toward trouble. */
export interface BriefRisk {
  id: string;
  title: string;
  severity: BriefRiskSeverity;
  description: string;
  objectType: string;
  objectId: string;
}

// ---------------------------------------------------------------------------
// Aggregate envelope. The generator fills every field (arrays may be
// empty); the web endpoint overwrites `pendingApprovalCount` and
// `totalAgentCostToday` with live counts before serving so a stale
// cached brief never shows an out-of-date badge.
// ---------------------------------------------------------------------------

export interface DailyBrief {
  id: string;
  tenantId: string;
  /** ISO 8601 generation timestamp — the UI shows this as "Updated 6:02 AM". */
  generatedAt: string;
  /** Seeded from vexCopy.brief (morning vs afternoon variant). */
  greeting: string;
  priorities: BriefPriority[];
  handled: BriefHandledItem[];
  blocked: BriefBlockedItem[];
  /** Subset of priorities that only the workspace owner should handle
   *  (compliance holds, exec escalations) — separate so an IC dashboard
   *  can surface them distinctly. */
  ownerOnly: BriefPriority[];
  pipeline: BriefPipelineItem[];
  risks: BriefRisk[];
  /** One-sentence recommendation, emitted by the brief agent. */
  recommendedFocus: string;
  totalAgentCostToday: number;
  pendingApprovalCount: number;
}
