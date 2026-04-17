export { initOtel, shutdownOtel } from "./otel.js";
export type { OtelInitOptions } from "./otel.js";
export { tracer } from "./tracer.js";
export { InMemoryCostLedger } from "./cost-ledger.js";
export type { CostLedger, CostEntry, CostOperation } from "./cost-ledger.js";
export {
  recordAgentRun,
  recordAgentSkipped,
  recordApprovalPendingDelta,
  recordEvidenceCount,
  recordQueryLatency,
  recordWebhookReceived,
  recordNeonLatency,
  recordQueueDepth,
  recordQueueBackpressure,
  measureNeonLatency,
  type AgentRunLabels,
  type AgentSkipReason,
  type WebhookOutcome,
} from "./metrics.js";
export {
  withSpan,
  currentTraceContext,
  currentTraceparent,
} from "./spans.js";
export { createLogger, type Logger, type LogFields, type LogLevel } from "./logger.js";
