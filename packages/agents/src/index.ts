export {
  ActionDescriptor,
  actionRequiresApproval,
  type ActionDescriptorT,
} from "./action.js";
export {
  EvalEntry,
  EvalFixture,
  loadFixture,
  type EvalEntryT,
  type EvalFixtureT,
} from "./evals/fixture.js";
export {
  QueryName,
  QUERY_PROMPT_VERSION,
  QUERY_SYSTEM_PROMPT,
  DAILY_BRIEF_SYSTEM_PROMPT,
  DAILY_BRIEF_PROMPT_VERSION,
  RESEARCH_SYSTEM_PROMPT,
  RESEARCH_PROMPT_VERSION,
  FOLLOW_UP_SYSTEM_PROMPT,
  FOLLOW_UP_PROMPT_VERSION,
} from "./prompts/index.js";
export {
  QueueName,
  QueueConcurrency,
  createRedisConnection,
  createQueues,
  addNormalizationJob,
  addAgentJob,
  addApprovalExecutorJob,
  scheduleRecurringAgents,
  createNormalizationWorker,
  createDlqWorker,
  createAgentWorker,
  createApprovalExecutorWorker,
  type QueueHandles,
  type NormalizationJobData,
  type DlqJobData,
  type AgentJobData,
  type AgentJobKind,
  type ApprovalExecutorJobData,
  type WorkerFactoryOptions,
} from "./queues.js";
export {
  buildNormalizationProcessor,
  buildDlqProcessor,
  registerDlqDepthGauge,
  type NormalizationProcessorDeps,
  type DlqProcessorDeps,
} from "./processors/index.js";
export {
  AgentRunner,
  type AgentRunRecord,
  type AgentRunRequest,
  type AgentRunnerDeps,
} from "./agent-runner.js";
export { ApprovalGate } from "./approval-gate.js";
export {
  DailyBriefAgent,
  FollowUpAgent,
  MarketingAnalystAgent,
  ResearchAgent,
  computeAnomalies,
  type AgentContext,
  type AgentOutput,
  type IAgent,
  type MarketingAnalystInput,
  type MarketingAnomaly,
  type MarketingMetricSnapshot,
  type ResearchAgentInput,
} from "./agents/index.js";
export { detectAnomaly, type AnomalyInput, type AnomalyResult } from "./anomaly.js";
export {
  MARKETING_ANALYST_SYSTEM_PROMPT,
  MARKETING_ANALYST_PROMPT_VERSION,
} from "./prompts/marketing-analyst.js";
