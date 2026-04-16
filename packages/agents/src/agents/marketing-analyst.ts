import { TenantId, type EvidenceItem, type EvidencePack } from "@vex/domain";
import { validateManifest } from "@vex/ui";
import { MARKETING_ANALYST_SYSTEM_PROMPT } from "../prompts/marketing-analyst.js";
import { detectAnomaly } from "../anomaly.js";
import type { AgentContext, AgentOutput, IAgent } from "./types.js";

const REPORT_WINDOW_DAYS = 7;
const HISTORY_WINDOW_DAYS = 30;

/**
 * Snapshot of one metric for one window. The polling job writes these as
 * versioned summaries; the agent reads the latest version per metric+
 * subject and computes the rolling stats.
 */
export interface MarketingMetricSnapshot {
  /** Stable metric identifier — e.g. `ga4.sessions`, `email.click_rate`. */
  metric: string;
  /** Subject (workspace, campaign, channel) the snapshot is for. */
  subjectType: "workspace" | "campaign" | "channel";
  subjectId: string;
  /** Numeric value for the window ending at `windowEnd`. */
  value: number;
  /** ISO timestamp at the right edge of the window. */
  windowEnd: string;
}

/** Agent input — the polling job populates this so the agent doesn't refetch. */
export interface MarketingAnalystInput {
  /** Last 7-day snapshots, one per (metric, subject). */
  current: MarketingMetricSnapshot[];
  /** Up to 30 days of historical snapshots, one entry per day per series. */
  history: MarketingMetricSnapshot[];
  /** Per-campaign roll-up the prompt uses for the breakdown table. */
  campaigns: Array<{
    campaignId: string;
    campaign: string;
    channel: string;
    sessions: number;
    conversions: number;
    clickRate: number;
  }>;
}

export interface MarketingAnomaly {
  metric: string;
  subjectType: string;
  subjectId: string;
  zScore: number;
  direction: "up" | "down" | "flat";
  latest: number;
  mean: number;
}

/**
 * T0 read-only summariser. Runs hourly + 18:00 Mon-Fri. Computes
 * 30-day rolling-window anomalies per metric, then asks Claude to
 * compose a 3-panel ViewManifest. Writes:
 *   - one workspace-scoped `marketing_overview` summary
 *   - one `campaign_marketing` summary per campaign in the input
 *
 * Cost is recorded by AnthropicAdapter; this agent doesn't run any other
 * paid operation.
 */
export class MarketingAnalystAgent implements IAgent {
  readonly name = "marketing_analyst";
  readonly tier = "T0" as const;

  constructor(private readonly input: MarketingAnalystInput) {}

  async run(ctx: AgentContext): Promise<AgentOutput> {
    const anomalies = computeAnomalies(this.input.current, this.input.history);
    const evidencePack = buildPack(this.input, anomalies);

    const result = await ctx.anthropic.query({
      tenantId: TenantId(ctx.tenantId),
      idempotencyKey: `marketing_analyst:${ctx.agentRunId}`,
      systemPrompt: MARKETING_ANALYST_SYSTEM_PROMPT,
      evidencePack,
      userMessage: `Produce the workspace marketing overview for the last ${REPORT_WINDOW_DAYS} days.`,
      maxTokens: 1500,
    });

    const validation = validateManifest(result.viewManifest);

    const summaryContent = JSON.stringify({
      answer: result.answer,
      manifest: validation.success ? validation.manifest : validation.fallback,
      manifest_valid: validation.success,
      anomalies,
      window_days: REPORT_WINDOW_DAYS,
    });

    const overview = await ctx.summaries.upsert(ctx.tx, ctx.tenantId, {
      subjectType: "workspace",
      subjectId: ctx.workspaceId,
      summaryType: "marketing_overview",
      content: summaryContent,
    });

    let internalWrites = 1;
    const campaignSummaryIds: string[] = [];
    for (const c of this.input.campaigns) {
      const campaignSummary = await ctx.summaries.upsert(ctx.tx, ctx.tenantId, {
        subjectType: "campaign",
        subjectId: c.campaignId,
        summaryType: "campaign_marketing",
        content: JSON.stringify({
          campaign: c.campaign,
          channel: c.channel,
          sessions: c.sessions,
          conversions: c.conversions,
          click_rate: c.clickRate,
          window_days: REPORT_WINDOW_DAYS,
        }),
      });
      campaignSummaryIds.push(campaignSummary.id);
      internalWrites++;
    }

    // Persist anomalies as audit events so the /marketing/anomalies
    // endpoint can list the last 7 days without re-running the analyst.
    for (const a of anomalies) {
      await ctx.events.insertIfNotExists(ctx.tx, ctx.tenantId, {
        verb: "marketing.anomaly",
        subjectType: a.subjectType,
        subjectId: a.subjectId,
        actorType: "system",
        actorId: this.name,
        objectType: "metric",
        objectId: a.metric,
        occurredAt: new Date(),
        idempotencyKey: `marketing.anomaly:${ctx.agentRunId}:${a.metric}:${a.subjectId}`,
        metadata: {
          z_score: a.zScore,
          direction: a.direction,
          latest: a.latest,
          mean: a.mean,
        },
      });
      internalWrites++;
    }

    return {
      costUsd: result.costUsd,
      outputRefs: {
        summary_id: overview.id,
        campaign_summary_ids: campaignSummaryIds,
        anomalies: anomalies.length,
        manifest_valid: validation.success,
      },
      proposedActions: [],
      internalWrites,
      rationale: `${anomalies.length} anomalies, ${this.input.campaigns.length} campaigns`,
    };
  }
}

/**
 * For every metric+subject in `current`, compute the 30-day rolling stats
 * over `history` and flag if the latest deviates > 2 std-devs.
 */
export function computeAnomalies(
  current: MarketingMetricSnapshot[],
  history: MarketingMetricSnapshot[],
): MarketingAnomaly[] {
  const anomalies: MarketingAnomaly[] = [];
  for (const c of current) {
    const series = history
      .filter(
        (h) =>
          h.metric === c.metric &&
          h.subjectType === c.subjectType &&
          h.subjectId === c.subjectId,
      )
      .map((h) => h.value);
    const result = detectAnomaly({ latest: c.value, history: series });
    if (result?.isAnomaly) {
      anomalies.push({
        metric: c.metric,
        subjectType: c.subjectType,
        subjectId: c.subjectId,
        zScore: roundToTwo(result.zScore),
        direction: result.direction,
        latest: c.value,
        mean: roundToTwo(result.mean),
      });
    }
  }
  return anomalies;
}

function roundToTwo(n: number): number {
  if (!Number.isFinite(n)) return n;
  return Math.round(n * 100) / 100;
}

function buildPack(
  input: MarketingAnalystInput,
  anomalies: MarketingAnomaly[],
): EvidencePack {
  const items: EvidenceItem[] = [];
  const summaries: EvidenceItem[] = [];
  const now = Date.now();

  for (const snap of input.current) {
    items.push({
      chunk_id: `metric:${snap.metric}:${snap.subjectId}`,
      object_type: snap.subjectType,
      object_id: snap.subjectId,
      chunk_text: `${snap.metric} for ${snap.subjectType}=${snap.subjectId} window_end=${snap.windowEnd} value=${snap.value}`,
      source_ref: `metric ${snap.metric}`,
      source_type: "summary",
      occurred_at: new Date(snap.windowEnd),
      freshness_hours: Math.max(
        0,
        (now - new Date(snap.windowEnd).getTime()) / 3_600_000,
      ),
      confidence_score: 0.9,
      corroborated_by_count: 0,
      permission_scope: "workspace",
      raw_event_ref: null,
      summary_version: null,
    });
  }

  for (const c of input.campaigns) {
    summaries.push({
      chunk_id: `campaign:${c.campaignId}`,
      object_type: "campaign",
      object_id: c.campaignId,
      chunk_text: `${c.campaign} (channel=${c.channel}) sessions=${c.sessions} conversions=${c.conversions} click_rate=${c.clickRate}`,
      source_ref: `campaign ${c.campaignId}`,
      source_type: "summary",
      occurred_at: new Date(),
      freshness_hours: 0,
      confidence_score: 1,
      corroborated_by_count: 0,
      permission_scope: "workspace",
      raw_event_ref: null,
      summary_version: 0,
    });
  }

  for (const a of anomalies) {
    summaries.push({
      chunk_id: `anomaly:${a.metric}:${a.subjectId}`,
      object_type: "anomaly",
      object_id: `${a.metric}:${a.subjectId}`,
      chunk_text: `ANOMALY ${a.metric} ${a.subjectType}=${a.subjectId} direction=${a.direction} z=${a.zScore} latest=${a.latest} mean=${a.mean}`,
      source_ref: `anomaly ${a.metric}`,
      source_type: "summary",
      occurred_at: new Date(),
      freshness_hours: 0,
      confidence_score: 1,
      corroborated_by_count: 0,
      permission_scope: "workspace",
      raw_event_ref: null,
      summary_version: 0,
    });
  }

  return {
    items,
    summaries,
    estimated_tokens:
      items.length * 30 + summaries.length * 30 + HISTORY_WINDOW_DAYS,
  };
}
