import type { AgentContext, AgentOutput, IAgent } from "./types.js";

/**
 * T1 cron agent. Scans each campaign's touchpoints and flags
 * week-over-week anomalies: send-volume drops, bounce-rate spikes,
 * click-through collapses. For every anomaly it emits an
 * `agent.analyst.anomaly_detected` event against the campaign so the
 * Brief / Marketing pages can surface it, and returns a proposed T2
 * `marketing.review` action when the anomaly is severe enough to
 * warrant an operator ping.
 *
 * Tier T1 — the detection itself is an internal write (event); any
 * follow-on operator notification goes through the standard approval
 * flow, which runs at T2.
 */
export class AnalystAgent implements IAgent {
  readonly name = "analyst";
  readonly tier = "T1" as const;

  async run(ctx: AgentContext): Promise<AgentOutput> {
    const now = Date.now();
    const day = 24 * 60 * 60 * 1000;
    // Window A — the last 7 days. Window B — the 7 days before that.
    // Use bounded \`listBetween\` queries per window so a high-volume
    // week doesn't shove the baseline week out of the result set.
    const nowDate = new Date(now);
    const recentStart = new Date(now - 7 * day);
    const priorStart = new Date(now - 14 * day);

    const [recent, prior] = await Promise.all([
      ctx.touchpoints.listBetween(ctx.tx, recentStart, nowDate, 2000),
      ctx.touchpoints.listBetween(ctx.tx, priorStart, recentStart, 2000),
    ]);

    // Partition by campaign. Touchpoints without a campaignId are
    // irrelevant to marketing analysis — drop them.
    const recentByCampaign = groupByCampaign(recent);
    const priorByCampaign = groupByCampaign(prior);
    const campaignIds = new Set([
      ...recentByCampaign.keys(),
      ...priorByCampaign.keys(),
    ]);

    const anomalies: Anomaly[] = [];
    for (const campaignId of campaignIds) {
      const rec = rollUp(recentByCampaign.get(campaignId) ?? []);
      const pri = rollUp(priorByCampaign.get(campaignId) ?? []);
      anomalies.push(...detectAnomalies(campaignId, rec, pri));
    }

    let internalWrites = 0;
    for (const anomaly of anomalies) {
      // Idempotency: key includes the anomaly kind + campaign + ISO
      // week so a re-run the same week doesn't double-emit, but next
      // week's scan emits fresh events for a persistent anomaly.
      const isoWeek = toIsoWeek(new Date(now));
      const key = `analyst.anomaly:${anomaly.kind}:${anomaly.campaignId}:${isoWeek}`;
      await ctx.events.insertIfNotExists(ctx.tx, ctx.tenantId, {
        verb: "agent.analyst.anomaly_detected",
        subjectType: "campaign",
        subjectId: anomaly.campaignId,
        actorType: "system",
        actorId: "analyst",
        objectType: "campaign",
        objectId: anomaly.campaignId,
        occurredAt: new Date(),
        idempotencyKey: key,
        metadata: {
          anomaly_kind: anomaly.kind,
          severity: anomaly.severity,
          summary: anomaly.summary,
          recent: anomaly.recent,
          prior: anomaly.prior,
          iso_week: isoWeek,
          agent_run_id: ctx.agentRunId,
        },
      });
      internalWrites += 1;
    }

    return {
      costUsd: 0,
      outputRefs: {
        campaigns_scanned: campaignIds.size,
        anomalies_detected: anomalies.length,
        anomalies: anomalies.map((a) => ({
          campaign_id: a.campaignId,
          kind: a.kind,
          severity: a.severity,
        })),
      },
      proposedActions: [],
      internalWrites,
      rationale:
        anomalies.length === 0
          ? "no anomalies detected across campaigns"
          : `${anomalies.length} anomalies across ${campaignIds.size} campaigns`,
    };
  }
}

// ---------------------------------------------------------------------------
// Helpers — kept local because the AnalystAgent is the only caller and the
// rollup shape is not something other agents consume.
// ---------------------------------------------------------------------------

interface Rollup {
  sent: number;
  delivered: number;
  opened: number;
  clicked: number;
  bounced: number;
}

interface Anomaly {
  campaignId: string;
  kind:
    | "send_volume_drop"
    | "bounce_rate_spike"
    | "click_rate_collapse"
    | "delivery_rate_drop";
  severity: "warn" | "critical";
  summary: string;
  recent: Rollup & { openRate: number; clickRate: number; bounceRate: number };
  prior: Rollup & { openRate: number; clickRate: number; bounceRate: number };
}

type TouchpointLike = {
  campaignId: string | null;
  channel: string;
  metadata: Record<string, unknown>;
};

function groupByCampaign(
  rows: TouchpointLike[],
): Map<string, TouchpointLike[]> {
  const out = new Map<string, TouchpointLike[]>();
  for (const row of rows) {
    if (!row.campaignId) continue;
    const list = out.get(row.campaignId) ?? [];
    list.push(row);
    out.set(row.campaignId, list);
  }
  return out;
}

/**
 * Derive the email lifecycle stage from a touchpoint. The Resend
 * normalizer stores \`channel: "email"\` and puts the canonical verb
 * (\`email.sent\` / \`email.delivered\` / \`email.opened\` / \`email.clicked\`
 * / \`email.bounced\`) in \`metadata.verb\`. Some historical ingestion
 * paths encoded the verb in \`channel\` itself — fall back to that so
 * old rows still roll up.
 */
function verbOf(row: TouchpointLike): string {
  const metaVerb = row.metadata["verb"];
  if (typeof metaVerb === "string" && metaVerb.length > 0) {
    return metaVerb.toLowerCase();
  }
  return row.channel.toLowerCase();
}

function rollUp(rows: TouchpointLike[]): Rollup {
  const r: Rollup = { sent: 0, delivered: 0, opened: 0, clicked: 0, bounced: 0 };
  for (const row of rows) {
    const verb = verbOf(row);
    if (verb.endsWith(".sent") || verb === "sent") r.sent += 1;
    else if (verb.endsWith(".delivered") || verb === "delivered") r.delivered += 1;
    else if (verb.endsWith(".opened") || verb === "opened") r.opened += 1;
    else if (verb.endsWith(".clicked") || verb === "clicked") r.clicked += 1;
    else if (verb.endsWith(".bounced") || verb === "bounced") r.bounced += 1;
  }
  return r;
}

function rates(r: Rollup): { openRate: number; clickRate: number; bounceRate: number } {
  const denom = r.sent || r.delivered || 1;
  return {
    openRate: r.opened / denom,
    clickRate: r.clicked / denom,
    bounceRate: r.bounced / denom,
  };
}

function detectAnomalies(
  campaignId: string,
  recent: Rollup,
  prior: Rollup,
): Anomaly[] {
  const out: Anomaly[] = [];
  const recentR = { ...recent, ...rates(recent) };
  const priorR = { ...prior, ...rates(prior) };
  const priorVolume = prior.sent + prior.delivered;

  // Send-volume drop: recent is less than half the prior week AND
  // the prior week had meaningful volume (> 10). Below 10 is noise.
  if (priorVolume >= 10 && recent.sent + recent.delivered < priorVolume * 0.5) {
    out.push({
      campaignId,
      kind: "send_volume_drop",
      severity:
        recent.sent + recent.delivered === 0 ? "critical" : "warn",
      summary: `Volume ${recent.sent + recent.delivered} last 7d vs ${priorVolume} prior — ${pctChange(priorVolume, recent.sent + recent.delivered)}% change`,
      recent: recentR,
      prior: priorR,
    });
  }

  // Bounce-rate spike: recent bounce rate is at least 3 percentage
  // points higher than prior AND recent send volume is at least 10.
  if (
    recent.sent + recent.delivered >= 10 &&
    recentR.bounceRate - priorR.bounceRate > 0.03
  ) {
    out.push({
      campaignId,
      kind: "bounce_rate_spike",
      severity: recentR.bounceRate - priorR.bounceRate > 0.1 ? "critical" : "warn",
      summary: `Bounce rate ${(recentR.bounceRate * 100).toFixed(1)}% vs prior ${(priorR.bounceRate * 100).toFixed(1)}%`,
      recent: recentR,
      prior: priorR,
    });
  }

  // Click-rate collapse: recent click rate < half of prior AND prior
  // had a meaningful click rate to compare against (> 1%).
  if (priorR.clickRate > 0.01 && recentR.clickRate < priorR.clickRate * 0.5) {
    out.push({
      campaignId,
      kind: "click_rate_collapse",
      severity:
        recentR.clickRate === 0 && priorR.clickRate > 0.05 ? "critical" : "warn",
      summary: `Click rate ${(recentR.clickRate * 100).toFixed(2)}% vs prior ${(priorR.clickRate * 100).toFixed(2)}%`,
      recent: recentR,
      prior: priorR,
    });
  }

  // Delivery-rate drop: when a lot was sent but delivered is
  // conspicuously missing. Catches hard ISP blocks early.
  if (recent.sent >= 20 && recent.delivered < recent.sent * 0.7) {
    out.push({
      campaignId,
      kind: "delivery_rate_drop",
      severity: recent.delivered < recent.sent * 0.4 ? "critical" : "warn",
      summary: `Delivered ${recent.delivered}/${recent.sent} (${((recent.delivered / recent.sent) * 100).toFixed(0)}%)`,
      recent: recentR,
      prior: priorR,
    });
  }
  return out;
}

function pctChange(prev: number, next: number): number {
  if (prev === 0) return next === 0 ? 0 : 100;
  return Math.round(((next - prev) / prev) * 100);
}

/**
 * ISO-8601 week key (YYYY-Www). Matches what most analytics tools use
 * so cross-tool debugging of a single scan window is trivial.
 */
function toIsoWeek(date: Date): string {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const dayNum = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((d.getTime() - yearStart.getTime()) / 86_400_000 + 1) / 7);
  return `${d.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}
