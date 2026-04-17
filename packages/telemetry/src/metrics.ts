import { metrics } from "@opentelemetry/api";

const meter = metrics.getMeter("vex", "0.0.0");

/**
 * Vex business metrics. Names follow the `vex.<domain>.<measurement>`
 * convention so a single Grafana dashboard can pivot across components.
 *
 * The metric instances are module-level singletons — calling
 * `recordAgentRun` from many call sites all writes to the same instrument.
 */

const agentRunCounter = meter.createCounter("vex.agent.run.count", {
  description: "Agent runs grouped by agent + tenant + status.",
  unit: "{run}",
});
const agentCostCounter = meter.createCounter("vex.agent.cost_usd", {
  description: "USD cost per agent run.",
  unit: "USD",
});
const approvalPendingGauge = meter.createUpDownCounter("vex.approval.pending", {
  description: "Pending approvals per tenant. Increment on create, decrement on decide.",
  unit: "{approval}",
});
const evidenceCountHistogram = meter.createHistogram("vex.retrieval.evidence_count", {
  description: "Number of evidence items returned per retrieval call.",
  unit: "{item}",
});
const queryLatencyHistogram = meter.createHistogram("vex.retrieval.query_latency_ms", {
  description: "End-to-end retrieval query latency.",
  unit: "ms",
});
const webhookCounter = meter.createCounter("vex.webhook.received", {
  description: "Webhooks received, grouped by provider + status (ok/invalid/duplicate).",
  unit: "{request}",
});
const neonLatencyHistogram = meter.createHistogram("vex.neon.query_latency_ms", {
  description: "Latency of Postgres queries through the application client.",
  unit: "ms",
});
const agentSkippedCounter = meter.createCounter("vex.agent.skipped", {
  description: "Agent runs skipped before execution, grouped by reason.",
  unit: "{skip}",
});
const queueDepthGauge = meter.createUpDownCounter("vex.queue.depth", {
  description: "BullMQ queue depth (waiting + active) sampled by the worker.",
  unit: "{job}",
});
const queueBackpressureGauge = meter.createUpDownCounter("vex.queue.backpressure", {
  description:
    "1 when a queue is at/over its backpressure threshold, 0 otherwise. One sample per queue.",
  unit: "{state}",
});

// `vex.dlq.depth` (gauge) lives in @vex/agents/src/processors/dlq-processor
// because it observes BullMQ Queue counts. The telemetry package owns the
// other 7 metrics defined in this module.

export interface AgentRunLabels {
  agent_name: string;
  tenant_id: string;
  status:
    | "completed"
    | "failed"
    | "skipped_disabled"
    | "skipped_kill_switch"
    | "skipped_cost_limit";
}

export function recordAgentRun(labels: AgentRunLabels, costUsd: number): void {
  agentRunCounter.add(1, labels as unknown as Record<string, string>);
  if (costUsd > 0) {
    agentCostCounter.add(costUsd, {
      agent_name: labels.agent_name,
      tenant_id: labels.tenant_id,
    });
  }
}

export function recordApprovalPendingDelta(tenantId: string, delta: number): void {
  approvalPendingGauge.add(delta, { tenant_id: tenantId });
}

export function recordEvidenceCount(tenantId: string, count: number): void {
  evidenceCountHistogram.record(count, { tenant_id: tenantId });
}

export function recordQueryLatency(tenantId: string, ms: number): void {
  queryLatencyHistogram.record(ms, { tenant_id: tenantId });
}

export type WebhookOutcome = "ok" | "invalid_signature" | "duplicate" | "error";

export function recordWebhookReceived(provider: string, outcome: WebhookOutcome): void {
  webhookCounter.add(1, { provider, status: outcome });
}

export function recordNeonLatency(operation: string, ms: number): void {
  neonLatencyHistogram.record(ms, { operation });
}

/**
 * Wrap an async operation in a Neon-latency measurement. Records the
 * histogram even on error so failed queries don't disappear from the panel.
 */
export async function measureNeonLatency<T>(
  operation: string,
  fn: () => Promise<T>,
): Promise<T> {
  const start = Date.now();
  try {
    return await fn();
  } finally {
    recordNeonLatency(operation, Date.now() - start);
  }
}

export type AgentSkipReason =
  | "kill_switch"
  | "cost_limit"
  | "disabled"
  | "backpressure";

export function recordAgentSkipped(labels: {
  agent: string;
  tenant_id: string;
  reason: AgentSkipReason;
}): void {
  agentSkippedCounter.add(1, labels as unknown as Record<string, string>);
}

/**
 * Emit a sample of a queue's current depth. Meant to be called by the
 * worker on a short interval so the `vex.queue.depth` time series can be
 * alerted on.
 */
export function recordQueueDepth(queue: string, depth: number): void {
  queueDepthGauge.add(depth, { queue });
}

export function recordQueueBackpressure(queue: string, engaged: boolean): void {
  queueBackpressureGauge.add(engaged ? 1 : 0, { queue });
}
